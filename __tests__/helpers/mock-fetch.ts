import { AuthentaClient, type AuthentaClientOptions, type FetchLike } from '../../src';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON for JSON bodies, otherwise the raw body value. */
  body: unknown;
  signal: AbortSignal | undefined;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

/** A fetch that answers each request with the next handler, in order, and records every call. */
export function mockFetch(...handlers: Handler[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: unknown = init.body ?? undefined;
    if (typeof init.body === 'string' && headers['content-type'] === 'application/json') body = JSON.parse(init.body);
    const call: RecordedCall = { url, method: init.method ?? 'GET', headers, body, signal: init.signal ?? undefined };
    calls.push(call);
    const handler = handlers[calls.length - 1];
    if (!handler) throw new Error(`Unexpected request #${calls.length}: ${call.method} ${url}`);
    return handler(call);
  };
  return { fetch, calls };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function empty(status: number): Response {
  return new Response(null, { status });
}

export function text(status: number, body: string, contentType = 'text/plain'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

/** Backend error envelope: `{ rid, name, message, fields? }`. */
export function apiError(status: number, name: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { rid: 'rid-0001', name, message, ...extra });
}

/** Rejects like undici does when a connection fails. */
export function networkFailure(code = 'ECONNRESET'): Handler {
  return () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) }));
}

/** Never answers; rejects only when the request's signal aborts. */
export function hang(): Handler {
  return call =>
    new Promise<Response>((_resolve, reject) => {
      call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true });
    });
}

export const BASE_URL = 'https://api.example.test';

export function createClient(fetch: FetchLike, options: Partial<AuthentaClientOptions> = {}): AuthentaClient {
  return new AuthentaClient({ apiKey: 'api_test_key', baseUrl: BASE_URL, fetch, retryDelayMs: 0, ...options });
}
