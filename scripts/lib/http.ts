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

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  /**
   * Retries on network errors, 429 and 5xx (exponential backoff). An aborted `signal` (e.g. a
   * time budget) cancels the request in flight and stops retrying, including during a wait.
   */
  retries?: number;
  backoffMs?: number;
  /** Return false to stop retrying a 429/5xx whose body says waiting won't help. */
  retryIf?: (status: number, body: string) => boolean;
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
  const {
    timeoutMs = 15_000,
    retries = 1,
    backoffMs = 1_500,
    retryIf,
    headers,
    signal,
    ...init
  } = opts;
  const outer = signal ?? undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'user-agent': USER_AGENT, ...headers },
        signal: outer
          ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      lastError = new HttpError(res.status, url, body.slice(0, 4000));
      const retryable =
        (res.status === 429 || res.status >= 500) && (retryIf?.(res.status, body) ?? true);
      if (!retryable || outer?.aborted) break;
      const suggested = suggestedRetryMs(res.headers.get('retry-after'), body);
      if (attempt < retries) await sleep(suggested ?? backoffMs * 2 ** attempt, outer);
    } catch (err) {
      lastError = err;
      if (outer?.aborted) break;
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt, outer);
    }
    if (outer?.aborted) break;
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

/**
 * True when bytes labelled UTF-8 are really a single-byte encoding: they hold high bytes but
 * not one valid UTF-8 multi-byte sequence. (A feed that declares or defaults to UTF-8 while
 * sending Latin-1 would otherwise decode every accented letter to U+FFFD.) Mixed bytes — real
 * UTF-8 with a few stray bytes — stay UTF-8, since re-reading them as Windows-1252 would garble
 * the valid characters instead.
 */
export function isMislabelledSingleByte(bytes: Uint8Array): boolean {
  let valid = 0;
  let invalid = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b < 0x80) continue;
    const len =
      b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    let ok = len > 0 && i + len <= bytes.length;
    for (let k = 1; ok && k < len; k++) ok = (bytes[i + k]! & 0xc0) === 0x80;
    if (ok) {
      valid++;
      i += len - 1;
    } else invalid++;
  }
  return invalid > 0 && valid === 0;
}

/**
 * Decode bytes in `charset`, falling back to UTF-8 for labels the runtime doesn't know. Bytes
 * labelled UTF-8 that are clearly single-byte text are read as Windows-1252 (a superset of
 * Latin-1) rather than turned into replacement characters.
 */
export function decodeBody(bytes: Uint8Array, charset: string): string {
  const label = charset.toLowerCase();
  if ((label === 'utf-8' || label === 'utf8') && isMislabelledSingleByte(bytes))
    return new TextDecoder('windows-1252').decode(bytes);
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
