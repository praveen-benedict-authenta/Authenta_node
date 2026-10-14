import {
  InsufficientCreditsError,
  InvalidResponseError,
  JobCreationUncertainError,
  NetworkError,
  NotFoundError,
  ValidationError,
  type CreateJobRequest,
} from '../src';
import { createResponse, job, jobDetail, jobList } from './helpers/fixtures';
import { BASE_URL, apiError, createClient, empty, hang, json, mockFetch, networkFailure } from './helpers/mock-fetch';

const request: CreateJobRequest = {
  taskTypeId: '1',
  inputs: [{ slotName: 'original', fileName: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: 2048 }],
};

describe('jobs.create', () => {
  it('POSTs the backend request shape and returns { job, inputs }', async () => {
    const { fetch, calls } = mockFetch(() => json(201, createResponse()));
    const result = await createClient(fetch).jobs.create(request);

    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE_URL}/api/v1/jobs` });
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.body).toEqual({
      taskTypeId: '1',
      inputs: [{ slotName: 'original', fileName: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: 2048 }],
    });
    expect(result.job).toMatchObject({ id: '101', status: 'initiated' });
    expect(result.inputs[0]).toMatchObject({ slotName: 'original', uploadUrlExpiresAt: expect.any(String) });
  });

  it('serializes numeric and bigint task type IDs as strings, as the backend requires', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => json(201, createResponse()),
    );
    const client = createClient(fetch);
    await client.jobs.create({ ...request, taskTypeId: 13 });
    await client.jobs.create({ ...request, taskTypeId: 13n });
    expect((calls[0]?.body as { taskTypeId: unknown }).taskTypeId).toBe('13');
    expect((calls[1]?.body as { taskTypeId: unknown }).taskTypeId).toBe('13');
  });

  it('forwards pageCount for page-priced task types', async () => {
    const { fetch, calls } = mockFetch(() => json(201, createResponse()));
    await createClient(fetch).jobs.create({
      taskTypeId: '13',
      inputs: [{ slotName: 'original', fileName: 'contract.pdf', contentType: 'application/pdf', sizeBytes: 9000, pageCount: 4 }],
    });
    expect((calls[0]?.body as { inputs: unknown[] }).inputs[0]).toEqual({
      slotName: 'original',
      fileName: 'contract.pdf',
      contentType: 'application/pdf',
      sizeBytes: 9000,
      pageCount: 4,
    });
  });

  it('surfaces the backend 422 when a required pageCount is missing', async () => {
    const fields = [{ field: 'inputs', msg: 'pageCount is required for this task type' }];
    const { fetch } = mockFetch(() => apiError(422, 'VALIDATION_ERROR', 'Validation failed for inputs', { fields }));
    await expect(createClient(fetch).jobs.create({ ...request, taskTypeId: '13' })).rejects.toMatchObject({
      constructor: ValidationError,
      status: 422,
      fields,
    });
  });

  it('forwards face intelligence parameters', async () => {
    const { fetch, calls } = mockFetch(() => json(201, createResponse()));
    await createClient(fetch).jobs.create({ ...request, parameters: { isLivenessCheck: true } });
    expect((calls[0]?.body as { parameters: unknown }).parameters).toEqual({ isLivenessCheck: true });
  });

  it.each<[string, Partial<CreateJobRequest>]>([
    ['a non-numeric taskTypeId', { taskTypeId: 'ai-image-detection' }],
    ['a zero taskTypeId', { taskTypeId: '0' }],
    ['a fractional taskTypeId', { taskTypeId: 1.5 }],
    ['no inputs', { inputs: [] }],
    [
      'more than three inputs',
      {
        inputs: ['a', 'b', 'c', 'd'].map(slotName => ({ slotName, fileName: 'f', contentType: 'image/png', sizeBytes: 1 })),
      },
    ],
    ['zero sizeBytes', { inputs: [{ slotName: 'original', fileName: 'f', contentType: 'image/png', sizeBytes: 0 }] }],
    ['an empty contentType', { inputs: [{ slotName: 'original', fileName: 'f', contentType: ' ', sizeBytes: 1 }] }],
    ['a zero pageCount', { inputs: [{ slotName: 'original', fileName: 'f', contentType: 'application/pdf', sizeBytes: 1, pageCount: 0 }] }],
    [
      'duplicate slots',
      {
        inputs: [
          { slotName: 'original', fileName: 'a', contentType: 'image/png', sizeBytes: 1 },
          { slotName: 'original', fileName: 'b', contentType: 'image/png', sizeBytes: 1 },
        ],
      },
    ],
  ])('rejects %s locally without sending a request', async (_label, override) => {
    const { fetch, calls } = mockFetch();
    await expect(createClient(fetch).jobs.create({ ...request, ...override })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it('throws InsufficientCreditsError on 402 without treating it as uncertain', async () => {
    const { fetch } = mockFetch(() => apiError(402, 'INSUFFICIENT_BALANCE', 'Insufficient balance'));
    await expect(createClient(fetch).jobs.create(request)).rejects.toMatchObject({
      constructor: InsufficientCreditsError,
      code: 'INSUFFICIENT_BALANCE',
    });
  });

  it('throws NotFoundError for an unavailable task type', async () => {
    const { fetch } = mockFetch(() => apiError(404, 'TASK_TYPE_NOT_FOUND', 'Task type not found'));
    await expect(createClient(fetch).jobs.create(request)).rejects.toMatchObject({ constructor: NotFoundError, code: 'TASK_TYPE_NOT_FOUND' });
  });

  it('reports an ambiguous network failure as JobCreationUncertainError and does not retry', async () => {
    const { fetch, calls } = mockFetch(networkFailure('ECONNRESET'));
    const error = await createClient(fetch).jobs.create(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobCreationUncertainError);
    expect((error as JobCreationUncertainError).cause).toBeInstanceOf(NetworkError);
    expect(calls).toHaveLength(1);
  });

  it('reports a timeout as JobCreationUncertainError', async () => {
    const { fetch, calls } = mockFetch(hang());
    await expect(createClient(fetch, { timeoutMs: 20 }).jobs.create(request)).rejects.toBeInstanceOf(JobCreationUncertainError);
    expect(calls).toHaveLength(1);
  });

  it('reports a 5xx as JobCreationUncertainError, since the server may have committed the job first', async () => {
    const { fetch, calls } = mockFetch(() => apiError(500, 'INTERNAL_ERROR', 'Unexpected error'));
    const error = await createClient(fetch).jobs.create(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobCreationUncertainError);
    expect(calls).toHaveLength(1);
  });

  it('reports an abort after sending as JobCreationUncertainError', async () => {
    const { fetch } = mockFetch(hang());
    const controller = new AbortController();
    const promise = createClient(fetch).jobs.create(request, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(JobCreationUncertainError);
  });

  it('reports a connection that was refused as a plain NetworkError, because nothing was sent', async () => {
    const { fetch } = mockFetch(networkFailure('ECONNREFUSED'));
    const error = await createClient(fetch).jobs.create(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).possiblySent).toBe(false);
  });

  it('rejects a malformed create response', async () => {
    const { fetch } = mockFetch(() => json(201, { job: job(), inputs: [{ slotName: 'original' }] }));
    await expect(createClient(fetch).jobs.create(request)).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe('jobs.get', () => {
  it('returns job details with the raw result and artifacts', async () => {
    const result = { isFake: true, confidence: 0.91 };
    const { fetch } = mockFetch(() => json(200, jobDetail({ status: 'completed', result })));
    const detail = await createClient(fetch).jobs.get('101');
    expect(detail.status).toBe('completed');
    expect(detail.result).toEqual(result);
    expect(detail.artifacts).toHaveLength(1);
  });

  it.each(['abc', '12a', '-1', '', '99999999999999999999', ' '])('rejects job ID %p without sending a request', async id => {
    const { fetch, calls } = mockFetch();
    await expect(createClient(fetch).jobs.get(id)).rejects.toMatchObject({ constructor: ValidationError, code: 'INVALID_ID' });
    expect(calls).toHaveLength(0);
  });

  it('normalizes leading zeros in job IDs', async () => {
    const { fetch, calls } = mockFetch(() => json(200, jobDetail()));
    await createClient(fetch).jobs.get('00101');
    expect(calls[0]?.url).toBe(`${BASE_URL}/api/v1/jobs/101`);
  });

  it('accepts numeric and bigint job IDs', async () => {
    const { fetch, calls } = mockFetch(
      () => json(200, jobDetail()),
      () => json(200, jobDetail()),
    );
    await createClient(fetch).jobs.get(101);
    await createClient(fetch).jobs.get(101n);
    expect(calls.map(call => call.url)).toEqual([`${BASE_URL}/api/v1/jobs/101`, `${BASE_URL}/api/v1/jobs/101`]);
  });

  it('throws NotFoundError for a deleted or unknown job', async () => {
    const { fetch } = mockFetch(() => apiError(404, 'JOB_NOT_FOUND', 'Job not found'));
    await expect(createClient(fetch).jobs.get('404')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('jobs.list', () => {
  it('omits unset query parameters so server defaults apply', async () => {
    const { fetch, calls } = mockFetch(() => json(200, jobList([job()])));
    const list = await createClient(fetch).jobs.list();
    expect(calls[0]?.url).toBe(`${BASE_URL}/api/v1/jobs`);
    expect(list).toMatchObject({ limit: 20, offset: 0, total: 1 });
  });

  it('sends limit/offset pagination and filters', async () => {
    const { fetch, calls } = mockFetch(() => json(200, jobList([], { limit: 10, offset: 30, total: 31 })));
    await createClient(fetch).jobs.list({
      limit: 10,
      offset: 30,
      status: 'completed',
      taskTypeSlug: 'ai-image-detection',
      createdAfter: new Date('2026-10-01T00:00:00Z'),
      createdBefore: '2026-10-14T00:00:00Z',
    });
    const url = new URL(calls[0]?.url ?? '');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '10',
      offset: '30',
      status: 'completed',
      taskTypeSlug: 'ai-image-detection',
      createdAfter: '2026-10-01T00:00:00.000Z',
      createdBefore: '2026-10-14T00:00:00.000Z',
    });
    expect(url.searchParams.has('page')).toBe(false);
  });

  it.each([{ limit: 0 }, { limit: 101 }, { limit: 2.5 }, { offset: -1 }, { createdAfter: 'not a date' }])(
    'rejects invalid params %p locally',
    async params => {
      const { fetch, calls } = mockFetch();
      await expect(createClient(fetch).jobs.list(params)).rejects.toBeInstanceOf(ValidationError);
      expect(calls).toHaveLength(0);
    },
  );

  it('iterates across pages until total is reached', async () => {
    const { fetch, calls } = mockFetch(
      () => json(200, jobList([job({ id: '3' }), job({ id: '2' })], { limit: 2, offset: 0, total: 3 })),
      () => json(200, jobList([job({ id: '1' })], { limit: 2, offset: 2, total: 3 })),
    );
    const ids: string[] = [];
    for await (const item of createClient(fetch).jobs.iterate({ limit: 2 })) ids.push(item.id);
    expect(ids).toEqual(['3', '2', '1']);
    expect(calls.map(call => new URL(call.url).searchParams.get('offset'))).toEqual(['0', '2']);
  });

  it('stops iterating on an empty page even if total is stale', async () => {
    const { fetch, calls } = mockFetch(
      () => json(200, jobList([job()], { limit: 1, offset: 0, total: 5 })),
      () => json(200, jobList([], { limit: 1, offset: 1, total: 5 })),
    );
    const items = [];
    for await (const item of createClient(fetch).jobs.iterate({ limit: 1 })) items.push(item);
    expect(items).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});

describe('jobs.cancel and jobs.delete', () => {
  it('cancels a job and returns the flat job response', async () => {
    const { fetch, calls } = mockFetch(() => json(200, job({ status: 'cancelled' })));
    await expect(createClient(fetch).jobs.cancel('101')).resolves.toMatchObject({ status: 'cancelled' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE_URL}/api/v1/jobs/101/cancel` });
  });

  it('throws ValidationError (422) when the job can no longer be cancelled', async () => {
    const { fetch } = mockFetch(() => apiError(422, 'CANCEL_NOT_ALLOWED', 'Cancel not allowed'));
    await expect(createClient(fetch).jobs.cancel('101')).rejects.toMatchObject({ constructor: ValidationError, code: 'CANCEL_NOT_ALLOWED' });
  });

  it('deletes a job and resolves on 204', async () => {
    const { fetch, calls } = mockFetch(() => empty(204));
    await expect(createClient(fetch).jobs.delete('101')).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `${BASE_URL}/api/v1/jobs/101` });
  });

  it('throws ValidationError when deleting a processing job', async () => {
    const { fetch } = mockFetch(() => apiError(422, 'JOB_DELETE_NOT_ALLOWED', 'Job is processing'));
    await expect(createClient(fetch).jobs.delete('101')).rejects.toMatchObject({ code: 'JOB_DELETE_NOT_ALLOWED' });
  });
});
