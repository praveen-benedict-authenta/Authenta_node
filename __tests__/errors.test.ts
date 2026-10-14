import {
  AuthentaError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  InsufficientCreditsError,
  InvalidResponseError,
  NotFoundError,
  QuotaExceededError,
  ServerError,
  ValidationError,
} from '../src';
import { errorFromResponse } from '../src/errors';
import { apiError, createClient, json, mockFetch, text } from './helpers/mock-fetch';

describe('errorFromResponse', () => {
  it.each([
    [400, ValidationError],
    [401, AuthenticationError],
    [402, InsufficientCreditsError],
    [403, AuthorizationError],
    [404, NotFoundError],
    [409, ConflictError],
    [413, ValidationError],
    [422, ValidationError],
    [429, QuotaExceededError],
    [500, ServerError],
    [503, ServerError],
    [418, AuthentaError],
  ])('maps HTTP %i to %p', (status, ErrorClass) => {
    expect(errorFromResponse(status, { name: 'X', message: 'm' })).toBeInstanceOf(ErrorClass);
  });

  it('preserves the backend name, message, rid and fields', () => {
    const fields = [{ field: 'inputs', msg: 'Missing input for slot "original"' }];
    const error = errorFromResponse(422, { rid: 'rid-42', name: 'VALIDATION_ERROR', message: 'Validation failed', fields });
    expect(error).toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      requestId: 'rid-42',
      fields,
    });
    expect(error.name).toBe('ValidationError');
  });

  it('falls back to a generic message when the body is not an error envelope', () => {
    const error = errorFromResponse(502, '<html>Bad gateway</html>');
    expect(error.message).toBe('Authenta API request failed with HTTP 502');
    expect(error.code).toBeUndefined();
    expect(error.body).toBe('<html>Bad gateway</html>');
  });

  it('ignores malformed fields', () => {
    expect(errorFromResponse(422, { name: 'VALIDATION_ERROR', fields: 'nope' }).fields).toBeUndefined();
  });

  it('parses Retry-After seconds on 429', () => {
    const error = errorFromResponse(429, { name: 'RATE_LIMITED' }, new Headers({ 'retry-after': '3' }));
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect((error as QuotaExceededError).retryAfterMs).toBe(3000);
  });

  it('handles a 404 without rid, as returned for unknown routes', () => {
    const error = errorFromResponse(404, { name: 'NOT_FOUND', message: 'Not found' });
    expect(error).toMatchObject({ code: 'NOT_FOUND', requestId: undefined });
  });
});

describe('API error handling through the client', () => {
  it('throws AuthenticationError with backend details for an invalid key', async () => {
    const { fetch } = mockFetch(() => apiError(401, 'INVALID_API_KEY', 'Invalid API key'));
    await expect(createClient(fetch).jobs.get('101')).rejects.toMatchObject({
      constructor: AuthenticationError,
      status: 401,
      code: 'INVALID_API_KEY',
      requestId: 'rid-0001',
    });
  });

  it('throws NotFoundError for a missing job', async () => {
    const { fetch } = mockFetch(() => apiError(404, 'JOB_NOT_FOUND', 'Job not found'));
    await expect(createClient(fetch).jobs.get('999')).rejects.toMatchObject({ constructor: NotFoundError, code: 'JOB_NOT_FOUND' });
  });

  it('keeps a non-JSON error body as truncated text', async () => {
    const { fetch } = mockFetch(() => text(500, 'x'.repeat(5000)));
    const error = await createClient(fetch).jobs.get('101').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(String((error as ServerError).body).length).toBeLessThanOrEqual(1001);
  });

  it('throws InvalidResponseError for a non-JSON success body', async () => {
    const { fetch } = mockFetch(() => text(200, '<html>proxy page</html>', 'text/html'));
    await expect(createClient(fetch).jobs.get('101')).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('throws InvalidResponseError when required fields are missing', async () => {
    const { fetch } = mockFetch(() => json(200, { job: { id: '101', status: 'completed' } }));
    await expect(createClient(fetch).jobs.get('101')).rejects.toMatchObject({ constructor: InvalidResponseError, code: 'INVALID_RESPONSE' });
  });
});
