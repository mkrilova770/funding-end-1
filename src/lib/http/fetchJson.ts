export class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, opts: { status: number; url: string }) {
    super(message);
    this.name = "HttpError";
    this.status = opts.status;
    this.url = opts.url;
  }
}

const DEFAULT_HEADERS: HeadersInit = {
  Accept: "application/json",
  "User-Agent": "FundingScanner/1.0 (+https://github.com)",
};

export async function fetchJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = 25_000, ...rest } = init ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        ...DEFAULT_HEADERS,
        ...(rest.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(`HTTP ${res.status}: ${text.slice(0, 200)}`, {
        status: res.status,
        url,
      });
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseDelayMs: number },
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= opts.retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === opts.retries) break;
      await new Promise((r) =>
        setTimeout(r, opts.baseDelayMs * Math.pow(2, i)),
      );
    }
  }
  throw lastErr;
}
