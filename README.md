# Policy Knowledge Assistant (improved RAG)

Ask questions about public policy documents and get answers that cite the exact page they came from.
This project rebuilds the retrieval-augmented generation (RAG) assistant from my class notebook and
fixes its main weakness: **duplicate chunks**.

- **Public chat** (`/`): anyone can ask questions. Answers come only from the published documents, with numbered citations and the cited passage highlighted.
- **Private admin page** (secret URL known only to the owner): upload documents, see what was indexed, and run the 25-question evaluation.
- **Public data only.** The library contains only publicly published policy documents.

**Live demo:** https://policy-knowledge-assistant.vercel.app

> Demo video: _link to be added_

---

## The problem this fixes

In the class notebook, uploading the same file twice indexed every chunk twice. A question would then
retrieve the top 5 chunks, but several of those 5 were identical copies, so:

1. fewer distinct passages reached the model (less evidence, worse answers), and
2. the sources list showed the same passage more than once.

## How the improved version works

```
Admin upload ──► fingerprint check ──► parse ──► strip headers/footers ──► page-aware chunks
                     │ (SHA-256)                                                │
                     └─ already indexed? block                                  ▼
                                                    exact-duplicate check (normalized text hash)
                                                                                │
                                                    embed (Gemini) ──► near-duplicate check (cosine ≥ 0.985)
                                                                                │
                                                                                ▼
                                                                         vector index
                                                                                │
Public question ──► embed ──► rank all chunks ──► pick top 5 *distinct* passages ──► Gemini answer with [n] citations
```

Duplicates are handled at four levels:

| Level | What it catches | How |
| --- | --- | --- |
| File | The same file uploaded again, even under a new name | SHA-256 of the bytes, checked in the browser before upload and again on the server |
| Boilerplate | Running headers, footers, page numbers repeated on every page | Lines appearing on at least half the pages are removed before chunking |
| Passage | The same text arriving in a different file (re-saved copy, reprint) | SHA-256 of normalized text (case, spacing, punctuation ignored) |
| Retrieval | Anything that still slips through | Top-k selection skips results with the same hash or embedding similarity ≥ 0.95 to a chosen result |

Other changes from the notebook:

- **Page-aware chunking.** Chunks never cross a page boundary, so every citation points to one exact page. Overlap is limited to one short sentence so it can't create near-duplicate chunks.
- **Grounded answers.** The model is told to use only the numbered passages, cite every claim, and reply "I couldn't find this in the published documents." when the answer isn't there.
- **Source display.** Each cited passage is shown as a file-tab card with document name and page, with the sentence that supports the answer highlighted.

## Evaluation (25 questions)

The admin page builds and runs the test set:

1. **Build.** 25 passages are picked evenly across all documents. For each one, Gemini writes a question a member of the public might ask, plus a short reference answer, using only that passage. The correct document and page are therefore known.
2. **Run.** Every question goes through two retrieval setups:
   - **Improved:** this app's index and distinct top-5 retrieval.
   - **Baseline:** a reproduction of the notebook bug, with every file indexed twice and plain top-5.
3. **Grade.** The improved answer is graded by Gemini for *faithfulness* (every claim supported by its sources) and *correctness* (matches the reference answer).

Metrics reported:

| Metric | Meaning |
| --- | --- |
| Right page in top 5 | Share of questions where the source page was retrieved |
| Mean reciprocal rank | 1.0 = the right page was always ranked first |
| Duplicate results in top 5 | Share of result slots wasted on a copy of another result |
| Faithfulness | Answers fully supported by their cited passages |
| Correctness | Answers matching the reference |

Results can be downloaded from the admin page as CSV or JSON.

### Results

_Run the evaluation on the deployed site and paste the table here._

| Metric | Improved | Baseline |
| --- | --- | --- |
| Right page in top 5 | | |
| Mean reciprocal rank | | |
| Duplicate results in top 5 | | |
| Faithfulness | | n/a |
| Correctness | | n/a |

**Limits of this evaluation:** questions are generated from single passages, so they favour
fact-lookup questions over questions that need several passages; grading uses the same model family
that produced the answers.

## Tech stack

- **Next.js 16** (App Router, TypeScript) on **Vercel**
- **Google Gemini**: `gemini-embedding-2` (768-dim embeddings) and `gemini-3.8-flash` (answers, question writing, grading); both configurable
- **Vercel Blob** (private store) for uploaded files and the index; the browser uploads files directly to Blob, so 10 MB files work
- **unpdf** (PDF text per page), **mammoth** (Word .docx)
- Brute-force cosine search in memory: exact, and fast for a library of a few thousand passages

## Project structure

```
src/
  app/
    page.tsx                  public chat
    admin/page.tsx            admin (login or dashboard)
    api/chat                  streaming answers with sources
    api/library               public list of documents
    api/admin/*               login, upload, ingest, documents, evaluation
  components/                 chat, admin dashboard, answer rendering
  lib/
    ingest.ts                 upload pipeline and all duplicate checks
    chunk.ts                  boilerplate removal and page-aware chunking
    retrieve.ts               distinct top-k and the naive baseline
    eval.ts                   test-set builder, runner, scoring
    ai.ts                     Gemini calls (with retry); offline mock for local tests
    storage.ts                Vercel Blob or local folder
    session.ts, auth.ts       signed admin session cookie
  proxy.ts                    serves the admin page only at the secret path and signs you in
```

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in GEMINI_API_KEY and ADMIN_PATH
npm run dev
```

Without `BLOB_READ_WRITE_TOKEN`, files are stored in `./.data`. To try the app without a Gemini key, set
`MOCK_AI=1` (offline stand-in: answers are not real, useful only for testing the pipeline and UI).

## Deploy on Vercel

1. Import this repository in Vercel.
2. Create a **private Blob store** and connect it to the project (this adds `BLOB_READ_WRITE_TOKEN`).
3. Add `GEMINI_API_KEY` and `ADMIN_PATH` (a long random string) as environment variables.
4. Redeploy, open `https://<your-site>/<ADMIN_PATH>` and upload documents.

## Security notes

- There are two URLs: the public chat at `/`, and the admin page at `/<ADMIN_PATH>`, which only the owner knows. `/admin` and any wrong path return 404.
- Opening the secret URL sets a signed, HTTP-only cookie (valid 12 hours). Every admin API (upload, delete, evaluation) checks that cookie, so the APIs can't be used without having opened the secret URL.
- The cookie signature is derived from `ADMIN_PATH`, so changing `ADMIN_PATH` in Vercel immediately locks out every old link and session. Do this if the link is ever shared by mistake.
- The admin page sends `noindex` and `no-referrer`, so it isn't indexed and its address isn't leaked to other sites.
- Public questions are rate-limited per IP. API keys live only in environment variables, never in the repository.
- Uploaded files are stored in a private Blob store and are not publicly downloadable.
