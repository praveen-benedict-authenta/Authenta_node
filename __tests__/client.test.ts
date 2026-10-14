import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AuthentaClient, NetworkError, RequestTimeoutError, SDK_VERSION, ServerError, ValidationError } from '../src';
import { jobDetail, jobList } from './helpers/fixtures';
import { BASE_URL, apiError, createClient, hang, json, mockFetch, networkFailure } from './helpers/mock-fetch';

describe('AuthentaClient construction', () => {
  it('requires an API key', () => {
    expect(() => new AuthentaClient({ apiKey: '' })).toThrow(ValidationError);
    expect(() => new AuthentaClient({ apiKey: '   ' })).toThrow('apiKey is required');
  });

  it('rejects API keys containing whitespace, which would corrupt the header', () => {
    expect(() => new AuthentaClient({ apiKey: 'api_abc\r\nX-Injected: 1' })).toThrow('whitespace');
  });

  it('defaults to the Authenta platform origin', () => {
    const { fetch } = mockFetch();
    expect(new AuthentaClient({ apiKey: 'api_x', fetch }).baseUrl).toBe('https://platform.authenta.ai');
  });

  it.each([
    ['https://host.test/', 'https://host.test'],
    ['https://host.test/api/v1', 'https://host.test'],
    ['https://host.test/api/v1/', 'https://host.test'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['https://host.test/proxy/authenta/', 'https://host.test/proxy/authenta'],
  ])('normalizes baseUrl %s to %s', (input, expected) => {
    const { fetch } = mockFetch();
    expect(new AuthentaClient({ apiKey: 'api_x', baseUrl: input, fetch }).baseUrl).toBe(expected);
  });

  it.each(['not a url', 'ftp://host.test', 'https://host.test/?q=1'])('rejects invalid baseUrl %s', baseUrl => {
    const { fetch } = mockFetch();
    expect(() => new AuthentaClient({ apiKey: 'api_x', baseUrl, fetch })).toThrow(ValidationError);
  });

  it('rejects negative timeouts', () => {
    const { fetch } = mockFetch();
    expect(() => new AuthentaClient({ apiKey: 'api_x', fetch, timeoutMs: -1 })).toThrow('timeoutMs');
  });

  it('keeps SDK_VERSION in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

describe('request construction', () => {
  it('sends the API key as a Bearer token with JSON and User-Agent headers', async () => {
    const { fetch, calls } = mockFetch(() => json(200, jobDetail()));
    await createClient(fetch).jobs.get('101');

    expect(calls[0]?.url).toBe(`${BASE_URL}/api/v1/jobs/101`);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers).toMatchObject({
      authorization: 'Bearer api_test_key',
      accept: 'application/json',
      'user-agent': `authenta-node/${SDK_VERSION}`,
    });
    expect(calls[0]?.headers['content-type']).toBeUndefined();
  });

  it('sets Content-Type only when a JSON body is sent', async () => {
    const { fetch, calls } = mockFetch(() => json(200, jobDetail({ status: 'queued' })));
    await createClient(fetch).jobs.finalize('101');
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers['content-type']).toBeUndefined();
  });

  it('allows overriding the User-Agent', async () => {
    const { fetch, calls } = mockFetch(() => json(200, jobDetail()));
    await createClient(fetch, { userAgent: 'my-app/1.0' }).jobs.get('101');
    expect(calls[0]?.headers['user-agent']).toBe('my-app/1.0');
  });
});

describe('timeouts and cancellation', () => {
  it('fails with RequestTimeoutError when the request exceeds timeoutMs', async () => {
    const { fetch } = mockFetch(hang());
    const client = createClient(fetch, { timeoutMs: 20, maxRetries: 0 });
    await expect(client.jobs.get('101')).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it('applies a per-call timeout override', async () => {
    const { fetch } = mockFetch(hang());
    const client = createClient(fetch, { timeoutMs: 60_000, maxRetries: 0 });
    await expect(client.jobs.get('101', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });

  it("rejects with the caller's abort reason", async () => {
    const { fetch } = mockFetch(hang());
    const controller = new AbortController();
    const promise = createClient(fetch).jobs.get('101', { signal: controller.signal });
    const reason = new Error('user cancelled');
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
  });

  it('does not send a request when the signal is already aborted', async () => {
    const { fetch, calls } = mockFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(createClient(fetch).jobs.get('101', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(0);
  });
});

describe('GET retries', () => {
  it('retries GET requests on 503 and succeeds', async () => {
    const { fetch, calls } = mockFetch(
      () => apiError(503, 'SERVICE_UNAVAILABLE', 'down'),
      () => json(200, jobList([])),
    );
    await expect(createClient(fetch).jobs.list()).resolves.toMatchObject({ total: 0 });
    expect(calls).toHaveLength(2);
  });

  it('retries GET requests on network errors', async () => {
    const { fetch, calls } = mockFetch(networkFailure(), () => json(200, jobDetail()));
    await expect(createClient(fetch).jobs.get('101')).resolves.toMatchObject({ id: '101' });
    expect(calls).toHaveLength(2);
  });

  it('gives up after maxRetries', async () => {
    const { fetch, calls } = mockFetch(networkFailure(), networkFailure(), networkFailure());
    await expect(createClient(fetch, { maxRetries: 2 }).jobs.get('101')).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toHaveLength(3);
  });

  it('does not retry a plain 500, which is not known to be transient', async () => {
    const { fetch, calls } = mockFetch(() => apiError(500, 'INTERNAL_ERROR', 'boom'));
    await expect(createClient(fetch).jobs.get('101')).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(1);
  });

  it('waits for Retry-After on 429 before retrying', async () => {
    const { fetch, calls } = mockFetch(
      () => json(429, { rid: 'rid-1', name: 'RATE_LIMITED', message: 'slow down' }, { 'retry-after': '0.05' }),
      () => json(200, jobDetail()),
    );
    const started = Date.now();
    await createClient(fetch).jobs.get('101');
    expect(calls).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('never retries POST requests', async () => {
    const { fetch, calls } = mockFetch(() => apiError(503, 'SERVICE_UNAVAILABLE', 'down'));
    await expect(createClient(fetch).jobs.cancel('101')).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(1);
  });
});
