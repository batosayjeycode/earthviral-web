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
      const retryAfter = Number(res.headers.get('retry-after'));
      if (attempt < retries)
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : backoffMs * 2 ** attempt,
        );
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function fetchText(url: string, opts?: FetchOptions): Promise<string> {
  return (await fetchWithRetry(url, opts)).text();
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
