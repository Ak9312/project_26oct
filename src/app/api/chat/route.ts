import { AiNotConfiguredError, aiErrorMessage, aiMode, embedQuery, NOT_FOUND, streamAnswer, type ChatTurn } from "@/lib/ai";
import { loadIndex } from "@/lib/index-store";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { rankChunks, retrieveUnique } from "@/lib/retrieve";
import type { Source } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const limit = rateLimit("chat:" + clientIp(req), 20, 5 * 60_000);
  if (!limit.ok) {
    return Response.json(
      { error: `Too many questions in a short time. Try again in ${limit.retryAfterS} seconds.` },
      { status: 429 }
    );
  }

  let body: { question?: string; history?: ChatTurn[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Send a question as JSON." }, { status: 400 });
  }
  const question = (body.question ?? "").trim();
  if (!question) return Response.json({ error: "Type a question first." }, { status: 400 });
  if (question.length > 600) {
    return Response.json({ error: "Keep questions under 600 characters." }, { status: 400 });
  }
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string")
    .slice(-4);

  if (aiMode === "missing") {
    return Response.json({ error: new AiNotConfiguredError().message }, { status: 503 });
  }

  const loaded = await loadIndex();
  if (!loaded.data.chunks.length) {
    return Response.json({ error: "No documents have been published yet." }, { status: 409 });
  }

  let sources: Source[];
  try {
    // embedQuery returns null when embeddings are off or unavailable; search then uses keywords only
    const { ranked } = rankChunks(loaded, question, await embedQuery(question));
    sources = retrieveUnique(loaded, ranked, 5).map((s, i) => ({
      n: i + 1,
      chunkId: s.chunk.id,
      docName: s.chunk.docName,
      page: s.chunk.page,
      locator: s.chunk.locator,
      text: s.chunk.text,
      score: Math.round(s.score * 10000) / 10000,
    }));
  } catch (e) {
    console.error("retrieval failed", e);
    return Response.json({ error: aiErrorMessage(e) }, { status: 502 });
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      send({ type: "sources", sources });
      if (!sources.length) {
        // nothing in the library shares a word with the question: no need to spend an AI call
        send({ type: "delta", text: NOT_FOUND });
        send({ type: "done" });
        controller.close();
        return;
      }
      try {
        for await (const delta of streamAnswer(question, sources, history)) send({ type: "delta", text: delta });
        send({ type: "done" });
      } catch (e) {
        console.error("generation failed", e);
        send({ type: "error", error: aiErrorMessage(e) });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

