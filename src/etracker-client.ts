export class EtrackerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    body: string,
  ) {
    super(`etracker API ${status} on ${path}: ${truncate(body, 500)}`);
    this.name = 'EtrackerApiError';
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export type EtrackerClientOptions = {
  apiUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 30s. */
  requestTimeoutMs?: number;
};

export type QueryValue = string | number | undefined;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Thin client for the etracker Report API. Authentication uses the static
 * `X-ET-Token` header (no login flow). Responses are JSON unless the server
 * answers with another content type (e.g. CSV), in which case the raw text is
 * returned.
 */
export class EtrackerClient {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: EtrackerClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T>(
    path: string,
    init: { query?: Record<string, QueryValue> } = {},
  ): Promise<T> {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'X-ET-Token': this.token,
          Accept: 'application/json',
        },
        signal: ctrl.signal,
      });
    } catch (err) {
      if (ctrl.signal.aborted) {
        throw new EtrackerApiError(0, path, `request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new EtrackerApiError(res.status, path, await res.text());
    }

    if (res.status === 204) return undefined as T;

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return (await res.json()) as T;
    }
    return (await res.text()) as T;
  }
}

/**
 * Resolves a date range to etracker's `YYYY-MM-DD` format. When `startDate` is
 * omitted but `rangeDays` is given, the start is computed relative to
 * `endDate` (or today). Values are passed through untouched otherwise so the
 * API can apply its own defaults.
 */
export function dateRange(input: {
  startDate?: string;
  endDate?: string;
  rangeDays?: number;
}): { startDate?: string; endDate?: string } {
  const fmt = (d: Date): string => d.toISOString().slice(0, 10);

  if (input.startDate || input.rangeDays === undefined) {
    return { startDate: input.startDate, endDate: input.endDate };
  }

  const end = input.endDate ? new Date(input.endDate) : new Date();
  const start = new Date(end.getTime() - input.rangeDays * 24 * 60 * 60 * 1000);
  return { startDate: fmt(start), endDate: input.endDate ?? fmt(end) };
}

/**
 * Returns the equally long period immediately preceding `[startDate, endDate]`
 * (both inclusive). For 2024-05-08..2024-05-14 (7 days) it yields
 * 2024-05-01..2024-05-07.
 */
export function previousRange(
  startDate: string,
  endDate: string,
): { startDate: string; endDate: string } {
  const dayMs = 24 * 60 * 60 * 1000;
  const fmt = (d: Date): string => d.toISOString().slice(0, 10);
  const start = new Date(startDate);
  const end = new Date(endDate);
  const lengthDays = Math.round((end.getTime() - start.getTime()) / dayMs) + 1;
  const prevEnd = new Date(start.getTime() - dayMs);
  const prevStart = new Date(prevEnd.getTime() - (lengthDays - 1) * dayMs);
  return { startDate: fmt(prevStart), endDate: fmt(prevEnd) };
}
