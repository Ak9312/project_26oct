import "server-only";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export type ParsedDoc = {
  kind: "pdf" | "docx" | "txt" | "md";
  locator: "Page" | "Section";
  /** Text of each page (PDF) or section (other formats), in order. */
  pages: string[];
};

export function detectKind(filename: string): ParsedDoc["kind"] | null {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "txt") return "txt";
  if (ext === "md" || ext === "markdown") return "md";
  return null;
}

/** Split long running text (Word, text, Markdown) into numbered sections of roughly page size. */
function splitIntoSections(text: string, target = 3000): string[] {
  const paras = text.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  const sections: string[] = [];
  let cur = "";
  for (const p of paras) {
    const para = p.trim();
    if (!para) continue;
    const startsHeading = /^#{1,3}\s/.test(para);
    if (cur && (cur.length + para.length > target || (startsHeading && cur.length > target / 3))) {
      sections.push(cur);
      cur = "";
    }
    cur = cur ? cur + "\n\n" + para : para;
  }
  if (cur) sections.push(cur);
  return sections;
}

export async function parseFile(buf: Buffer, filename: string): Promise<ParsedDoc> {
  const kind = detectKind(filename);
  if (!kind) throw new Error("Unsupported file type. Use PDF, Word (.docx), .txt or .md.");

  if (kind === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text]).map((t) => t ?? "");
    if (!pages.some((p) => p.trim().length > 20)) {
      throw new Error(
        "No readable text found in this PDF. It may be a scanned image; upload a text-based PDF instead."
      );
    }
    return { kind, locator: "Page", pages };
  }

  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { kind, locator: "Section", pages: splitIntoSections(value) };
  }

  return { kind, locator: "Section", pages: splitIntoSections(buf.toString("utf8")) };
}
