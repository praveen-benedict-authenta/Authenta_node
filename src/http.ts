/**
 * HTTP layer for the Authenta API: authentication, timeouts, cancellation, JSON handling and error mapping.
 *
 * Only GET requests are retried automatically. POST and DELETE requests change server state (and job
 * creation uses credits), so they are never retried here.
 */

import {
  AuthentaError,
  InvalidResponseError,
  NetworkError,
  QuotaExceededError,
  RequestTimeoutError,
  ServerError,
  errorFromResponse,
} from './errors';
import { abortReason, sleep, throwIfAborted, withTimeout } from './signals';
import type { FetchLike } from './types';

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface HttpConfig {
  apiKey: string;
  /** Base URL including the `/api/v1` prefix, without a trailing slash. */
  apiBaseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  fetch: FetchLike;
  userAgent: string;
}

export interface HttpRequest {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_RETRY_AFTER_MS = 30_000;
const NOT_SENT_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL']);
const MAX_RAW_BODY_LENGTH = 1000;

/** Walks an error's `cause` chain looking for a code proving the request never left this machine. */
function provesNotSent(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_SENT_ERROR_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function parseBody(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text.length > MAX_RAW_BODY_LENGTH ? `${text.slice(0, MAX_RAW_BODY_LENGTH)}…` : text;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof NetworkError || error instanceof RequestTimeoutError) return true;
  if (error instanceof QuotaExceededError) return true;
  return error instanceof ServerError && error.status !== undefined && RETRYABLE_STATUSES.has(error.status);
}

export class HttpClient {
  constructor(private readonly config: HttpConfig) {}

  /** Sends a request and returns the parsed JSON body (`undefined` for empty bodies). */
  async request<T>(req: HttpRequest): Promise<T> {
    const maxAttempts = req.method === 'GET' ? this.config.maxRetries + 1 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return (await this.send(req)) as T;
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryable(error) || req.signal?.aborted) throw error;
        const backoff = this.config.retryDelayMs * 2 ** (attempt - 1);
        const retryAfter = error instanceof QuotaExceededError ? error.retryAfterMs : undefined;
        await sleep(retryAfter === undefined ? backoff : Math.min(retryAfter, MAX_RETRY_AFTER_MS), req.signal);
      }
    }
  }

  private buildUrl(path: string, query?: HttpRequest['query']): string {
    const url = `${this.config.apiBaseUrl}${path}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.append(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  private async send(req: HttpRequest): Promise<unknown> {
    throwIfAborted(req.signal);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: 'application/json',
      'User-Agent': this.config.userAgent,
    };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';

    const timed = withTimeout(req.timeoutMs ?? this.config.timeoutMs, req.signal);
    let status: number;
    let responseHeaders: Headers;
    let text: string;
    try {
      const response = await this.config.fetch(this.buildUrl(req.path, req.query), {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: timed.signal,
      });
      status = response.status;
      responseHeaders = response.headers;
      text = await response.text();
    } catch (error) {
      if (req.signal?.aborted) throw abortReason(req.signal);
      if (timed.timedOut()) {
        throw new RequestTimeoutError(`${req.method} ${req.path} timed out`, { cause: error, code: 'REQUEST_TIMEOUT' });
      }
      if (error instanceof AuthentaError) throw error;
      throw new NetworkError(`${req.method} ${req.path} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
        code: 'NETWORK_ERROR',
        possiblySent: !provesNotSent(error),
      });
    } finally {
      timed.dispose();
    }

    const body = parseBody(text);
    if (status < 200 || status >= 300) throw errorFromResponse(status, body, responseHeaders);
    if (typeof body === 'string') {
      throw new InvalidResponseError(`${req.method} ${req.path} returned a non-JSON body`, { status, body, code: 'INVALID_RESPONSE' });
    }
    return body;
  }
}
