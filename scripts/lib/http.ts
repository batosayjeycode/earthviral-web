/** Polite HTTP helpers for the batch pipeline: identifiable UA, timeouts, bounded retries. */

export const USER_AGENT = 'EarthViralBot/1.0 (+https://earthviral.com/about/)';

// Explicit fields (no TS parameter properties): scripts run under Node's strip-only type stripping.
export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  constructor(status: number, url: string, body = '') {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  /** Retries on network errors, 429 and 5xx (exponential backoff). */
  retries?: number;
  backoffMs?: number;
}

const MAX_SUGGESTED_WAIT_MS = 60_000;

/**
 * Server-suggested wait before retrying: the `Retry-After` header (seconds), or Google's
 * RetryInfo in the JSON error body (`"retryDelay": "37s"`), capped at 60 s.
 */
export function suggestedRetryMs(retryAfterHeader: string | null, body: string): number | null {
  const header = Number(retryAfterHeader);
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, MAX_SUGGESTED_WAIT_MS);
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (m) return Math.min(Math.ceil(Number(m[1]) * 1000), MAX_SUGGESTED_WAIT_MS);
  return null;
}

export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 15_000, retries = 1, backoffMs = 1_500, headers, ...init } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'user-agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      const body = await res.text().catch(() => '');
      lastError = new HttpError(res.status, url, body.slice(0, 500));
      if (!retryable) break;
      const suggested = suggestedRetryMs(res.headers.get('retry-after'), body);
      if (attempt < retries) await sleep(suggested ?? backoffMs * 2 ** attempt);
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
    }
  }
  throw lastError;
}

/**
 * Character set of a response body: the Content-Type `charset`, else the XML declaration's
 * `encoding` (e.g. Folha's feed is `<?xml … encoding="ISO-8859-1"?>` served as plain
 * `text/xml`), else UTF-8. `Response.text()` always assumes UTF-8, which turned every
 * accented character of Latin-1 feeds into U+FFFD.
 */
export function detectCharset(contentType: string | null, head: Uint8Array): string {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const prolog = new TextDecoder('latin1').decode(head.subarray(0, 256));
  const fromXml = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(prolog)?.[1];
  return (fromXml ?? 'utf-8').toLowerCase();
}

/** Decode bytes in `charset`, falling back to UTF-8 for labels the runtime doesn't know. */
export function decodeBody(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export async function fetchText(url: string, opts?: FetchOptions): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return decodeBody(bytes, detectCharset(res.headers.get('content-type'), bytes));
}

/** Run async tasks with a concurrency limit, preserving input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export { sleep };
