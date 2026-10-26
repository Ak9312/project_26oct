export type DocRecord = {
  id: string;
  name: string;
  sha256: string;
  size: number;
  kind: "pdf" | "docx" | "txt" | "md";
  pages: number;
  chunkCount: number;
  /** Chunks dropped at ingest because the same text was already indexed. */
  duplicateChunksSkipped: number;
  /** Repeated header/footer lines removed before chunking. */
  boilerplateLinesRemoved: number;
  uploadedAt: string;
  blobPathname?: string;
};

export type ChunkRecord = {
  id: string;
  docId: string;
  docName: string;
  /** 1-based page (PDF) or section number (Word, text, Markdown). */
  page: number;
  locator: "Page" | "Section";
  text: string;
  /** SHA-256 of normalized text, used for exact-duplicate detection. */
  hash: string;
  /** Float32 embedding, base64 encoded. */
  emb: string;
};

export type IndexData = {
  version: 1;
  embedModel: string;
  dims: number;
  docs: DocRecord[];
  chunks: ChunkRecord[];
  stats: {
    duplicateFilesBlocked: number;
    duplicateChunksSkipped: number;
  };
  updatedAt: string;
};

export type Source = {
  n: number;
  chunkId: string;
  docName: string;
  page: number;
  locator: "Page" | "Section";
  text: string;
  score: number;
};

export type EvalQuestion = {
  id: string;
  question: string;
  expectedAnswer: string;
  goldChunkId: string;
  docName: string;
  page: number;
};

export type EvalQuestionSet = {
  createdAt: string;
  method: string;
  questions: EvalQuestion[];
};

export type EvalRetrievalResult = {
  hit: boolean;
  rank: number | null;
  /** How many of the top-k results were copies of another result. */
  duplicatesInTopK: number;
  retrieved: { chunkId: string; docName: string; page: number; score: number }[];
};

export type EvalResultRow = {
  id: string;
  question: string;
  expectedAnswer: string;
  docName: string;
  page: number;
  improved: EvalRetrievalResult;
  naive: EvalRetrievalResult;
  answer: string;
  notFound: boolean;
  faithful: boolean;
  correct: boolean;
  judgeNote: string;
  latencyMs: number;
};

export type EvalSummary = {
  runAt: string;
  aiMode: string;
  chatModel: string;
  embedModel: string;
  k: number;
  total: number;
  improved: { hitRate: number; mrr: number; duplicateRate: number };
  naive: { hitRate: number; mrr: number; duplicateRate: number };
  faithfulness: number;
  correctness: number;
  avgLatencyMs: number;
  rows: EvalResultRow[];
};
