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

// Function words that are common in headlines and specific to one side: English, or the
// non-English languages the feeds carry (Indonesian / Malay, Portuguese, Spanish, French,
// German). Words shared by both sides ("a", "as", "no", "die"…) are left out; "in" counts as
// English, since German and Dutch are not among the feeds' languages.
const ENGLISH_WORDS = new Set(
  `the of to in for on with after over is are was were at by from amid says said and its his her
  has have had will would into against how why what who be not than this that their they been`.split(
    /\s+/,
  ),
);
const FOREIGN_WORDS = new Set(
  `yang dan di ke dari untuk dengan ini itu tak tidak akan soal usai jadi kata pada oleh bagi
  karena hingga sebagai ada telah sudah belum masih bisa harus juga atau saat setelah para dalam
  lebih kini kepada tentang atas tanpa sangat jika terkait jelang kembali bersama menjadi ketika
  namun tetap
  o os um uma de do da dos das em na nos nas que com para por ao aos e é sao diz apos sobre mais
  el la los las del en y se es con una tras al le les des du et au aux une est sur pour dans
  avec apres contre selon der und mit fur nach ist ein eine auf von`.split(/\s+/),
);
const NON_LATIN = /[\u0370-\u1fff\u3000-\uffef]/;

function languageEvidence(title: string) {
  const words = normalize(title).split(/[^a-z]+/);
  return {
    english: words.filter((w) => ENGLISH_WORDS.has(w)).length,
    foreign: words.filter((w) => FOREIGN_WORDS.has(w)).length,
  };
}

/**
 * True when a headline is recognisably English: it has English function words, at least as
 * many as non-English ones (so names such as "Rio De Janeiro" don't outweigh the English).
 */
export function looksEnglish(title: string): boolean {
  if (NON_LATIN.test(title)) return false;
  const { english, foreign } = languageEvidence(title);
  return english > 0 && english >= foreign;
}

/**
 * True when a headline is recognisably not English: a non-Latin script, or more non-English
 * than English function words. Headlines with neither kind of word ("Matildas keeper reveals
 * health scare", "Bek Bali United Hadapi Trio Maut Persib") are neither English nor foreign.
 */
export function looksForeign(title: string): boolean {
  if (NON_LATIN.test(title)) return true;
  const { english, foreign } = languageEvidence(title);
  return foreign > english;
}

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
