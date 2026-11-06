/**
 * Language-light text utilities for clustering: tokenisation (EN / ID / PT), stopwords,
 * TF-IDF vectors and cosine similarity. CJK runs fall back to character bigrams.
 */

const STOPWORDS = new Set(
  `a an the and or but if of to in on at by for with from into onto over under about after before between during
  as is are was were be been being has have had do does did will would can could should may might must shall
  this that these those it its he she they them his her their we our you your i me my not no yes than then so
  up down out off new says say said after amid via vs what who whom which when where why how all more most
  just also still now today live latest update updates news video watch photos report reports here there over
  yang dan di ke dari ini itu untuk dengan pada dalam akan tidak ada juga atau oleh sebagai karena bagi agar
  para bisa jadi telah sudah masih saat usai hingga soal kata ia mereka kami kita apa siapa bagaimana mengapa
  lebih baru tahun hari jam pukul berita terkini viral simak begini ini cek
  o a os as um uma de do da dos das em no na nos nas por para com sem que se ao à é foi são ser mais`
    .split(/\s+/)
    .filter(Boolean),
);

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics: "são" → "sao"
    .replace(/[’'`]/g, '');
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of normalize(text).split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    if (CJK.test(raw)) {
      for (let i = 0; i < raw.length - 1; i++) tokens.push(raw.slice(i, i + 2));
      continue;
    }
    if (raw.length < 2 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    tokens.push(raw);
  }
  return tokens;
}

export type SparseVector = Map<string, number>;

/** Inverse document frequency over a corpus of token lists (smoothed). */
export function buildIdf(docs: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log((1 + docs.length) / (1 + n)) + 1);
  return idf;
}

export function tfidf(tokens: string[], idf: Map<string, number>): SparseVector {
  const v: SparseVector = new Map();
  for (const t of tokens) v.set(t, (v.get(t) ?? 0) + 1);
  let norm = 0;
  for (const [t, tf] of v) {
    const w = tf * (idf.get(t) ?? 1);
    v.set(t, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of v) v.set(t, w / norm);
  return v;
}

export function cosine(a: SparseVector, b: SparseVector): number {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) {
    const other = large.get(t);
    if (other) dot += w * other;
  }
  return dot;
}

/** Element-wise sum, re-normalised — a cluster centroid. */
export function centroid(vectors: SparseVector[]): SparseVector {
  const sum: SparseVector = new Map();
  for (const v of vectors) for (const [t, w] of v) sum.set(t, (sum.get(t) ?? 0) + w);
  let norm = 0;
  for (const w of sum.values()) norm += w * w;
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of sum) sum.set(t, w / norm);
  return sum;
}

export function slugify(text: string, maxWords = 9): string {
  return normalize(text)
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean) // keep stopwords: "what-we-know" reads better than "know"
    .slice(0, maxWords)
    .join('-')
    .slice(0, 80)
    .replace(/-+$/, '');
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}
