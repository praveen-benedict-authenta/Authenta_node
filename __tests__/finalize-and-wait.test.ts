import { ConflictError, JobTimeoutError, NotFoundError, ServerError, ValidationError, type AnyJobStatus } from '../src';
import { job, jobDetail } from './helpers/fixtures';
import { BASE_URL, apiError, createClient, json, mockFetch } from './helpers/mock-fetch';

describe('jobs.finalize', () => {
  it('returns the flat job response on success', async () => {
    const { fetch, calls } = mockFetch(() => json(200, job({ status: 'queued' })));
    await expect(createClient(fetch).jobs.finalize('101')).resolves.toMatchObject({ id: '101', status: 'queued' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE_URL}/api/v1/jobs/101/finalize` });
  });

  it.each(['queued', 'processing', 'completed', 'failed'])(
    'reconciles a 409 when the job is already %s',
    async status => {
      const { fetch, calls } = mockFetch(
        () => apiError(409, 'UPLOAD_ALREADY_FINALIZED', 'Already finalized'),
        () => json(200, jobDetail({ status })),
      );
      await expect(createClient(fetch).jobs.finalize('101')).resolves.toMatchObject({ status });
      expect(calls.map(call => call.method)).toEqual(['POST', 'GET']);
    },
  );

  it.each(['cancelled', 'initiated', 'some_future_status'])('rethrows the 409 when the job is %s', async status => {
    const { fetch } = mockFetch(
      () => apiError(409, 'UPLOAD_ALREADY_FINALIZED', 'Already finalized'),
      () => json(200, jobDetail({ status })),
    );
    const error = await createClient(fetch).jobs.finalize('101').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toContain(`"${status}"`);
    expect((error as ConflictError).code).toBe('UPLOAD_ALREADY_FINALIZED');
    expect((error as ConflictError).jobId).toBe('101');
  });

  it('does not reconcile 404 UPLOAD_NOT_FOUND', async () => {
    const { fetch, calls } = mockFetch(() => apiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found'));
    await expect(createClient(fetch).jobs.finalize('101')).rejects.toMatchObject({ constructor: NotFoundError, code: 'UPLOAD_NOT_FOUND' });
    expect(calls).toHaveLength(1);
  });

  it('is not retried on 503', async () => {
    const { fetch, calls } = mockFetch(() => apiError(503, 'SERVICE_UNAVAILABLE', 'down'));
    await expect(createClient(fetch).jobs.finalize('101')).rejects.toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(1);
  });
});

describe('jobs.waitForCompletion', () => {
  it.each(['completed', 'failed', 'cancelled'])('returns the job when it reaches %s', async status => {
    const { fetch } = mockFetch(
      () => json(200, jobDetail({ status: 'processing' })),
      () => json(200, jobDetail({ status })),
    );
    await expect(createClient(fetch).jobs.waitForCompletion('101', { intervalMs: 1 })).resolves.toMatchObject({ status });
  });

  it('keeps polling through processing → queued (retry) → completed and reports each change', async () => {
    const { fetch, calls } = mockFetch(
      () => json(200, jobDetail({ status: 'queued' })),
      () => json(200, jobDetail({ status: 'processing' })),
      () => json(200, jobDetail({ status: 'processing' })),
      () => json(200, jobDetail({ status: 'queued' })),
      () => json(200, jobDetail({ status: 'completed', result: { isFake: false } })),
    );
    const changes: [AnyJobStatus, AnyJobStatus | undefined][] = [];
    const finished = await createClient(fetch).jobs.waitForCompletion('101', {
      intervalMs: 1,
      onStatusChange: (current, previous) => changes.push([current.status, previous]),
    });
    expect(finished.result).toEqual({ isFake: false });
    expect(calls).toHaveLength(5);
    expect(changes).toEqual([
      ['queued', undefined],
      ['processing', 'queued'],
      ['queued', 'processing'],
      ['completed', 'queued'],
    ]);
  });

  it('throws JobTimeoutError with the last observed job', async () => {
    const { fetch } = mockFetch(...Array.from({ length: 50 }, () => () => json(200, jobDetail({ status: 'queued' }))));
    const error = await createClient(fetch)
      .jobs.waitForCompletion('101', { intervalMs: 5, timeoutMs: 30 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobTimeoutError);
    expect((error as JobTimeoutError).lastJob.status).toBe('queued');
    expect((error as JobTimeoutError).jobId).toBe('101');
  });

  it("stops with the caller's abort reason while sleeping between polls", async () => {
    const { fetch, calls } = mockFetch(...Array.from({ length: 5 }, () => () => json(200, jobDetail({ status: 'processing' }))));
    const controller = new AbortController();
    const reason = new Error('shutdown');
    const promise = createClient(fetch).jobs.waitForCompletion('101', { intervalMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(reason), 20);
    await expect(promise).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
  });

  it('survives a transient 503 during polling', async () => {
    const { fetch } = mockFetch(
      () => apiError(503, 'SERVICE_UNAVAILABLE', 'down'),
      () => json(200, jobDetail({ status: 'completed' })),
    );
    await expect(createClient(fetch).jobs.waitForCompletion('101', { intervalMs: 1 })).resolves.toMatchObject({ status: 'completed' });
  });

  it('propagates NotFoundError when the job disappears', async () => {
    const { fetch } = mockFetch(
      () => json(200, jobDetail({ status: 'initiated' })),
      () => apiError(404, 'JOB_NOT_FOUND', 'Job not found'),
    );
    await expect(createClient(fetch).jobs.waitForCompletion('101', { intervalMs: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([{ intervalMs: -1 }, { timeoutMs: 0 }, { timeoutMs: Number.NaN }])('rejects invalid options %p', async options => {
    const { fetch, calls } = mockFetch();
    await expect(createClient(fetch).jobs.waitForCompletion('101', options)).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });
});
