import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InvalidResponseError,
  JobCreationUncertainError,
  JobSubmissionError,
  JobTimeoutError,
  NotFoundError,
  RequestTimeoutError,
  UploadError,
  UploadUrlExpiredError,
  ValidationError,
  type AnalyzeOptions,
} from '../src';
import { createResponse, job, jobDetail } from './helpers/fixtures';
import { apiError, createClient, empty, hang, json, mockFetch, networkFailure, text, type RecordedCall } from './helpers/mock-fetch';

let tempDir: string;
let photoPath: string;
const photo = Buffer.from('jpeg-bytes');

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'authenta-node-analyze-'));
  photoPath = join(tempDir, 'selfie.jpg');
  await writeFile(photoPath, photo);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function options(overrides: Partial<AnalyzeOptions> = {}): AnalyzeOptions {
  return {
    taskTypeId: '8',
    inputs: [{ slotName: 'original', source: photoPath, contentType: 'image/jpeg' }],
    polling: { intervalMs: 1 },
    ...overrides,
  };
}

const describeCall = (call: RecordedCall): string => `${call.method} ${new URL(call.url).pathname}`;

describe('analyze', () => {
  it('creates, uploads, finalizes and waits, in that order', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse(['original'])),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
      () => json(200, jobDetail({ status: 'processing' })),
      () => json(200, jobDetail({ status: 'completed', result: { isFake: false } })),
    );
    const result = await createClient(fetch).analyze(options());

    expect(calls.map(describeCall)).toEqual([
      'POST /api/v1/jobs',
      'PUT /jobs/101/input/original.media',
      'POST /api/v1/jobs/101/finalize',
      'GET /api/v1/jobs/101',
      'GET /api/v1/jobs/101',
    ]);
    expect(calls[0]?.body).toEqual({
      taskTypeId: '8',
      inputs: [{ slotName: 'original', fileName: 'selfie.jpg', contentType: 'image/jpeg', sizeBytes: photo.byteLength }],
    });
    expect(calls[1]?.headers).toMatchObject({ 'content-type': 'image/jpeg', 'content-length': String(photo.byteLength) });
    expect(calls[1]?.headers.authorization).toBeUndefined();
    expect(result.job).toMatchObject({ status: 'completed', result: { isFake: false } });
    expect(result.created.job.id).toBe('101');
  });

  it('uploads every slot to its own URL and forwards parameters', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse(['original', 'reference'])),
      () => empty(200),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
      () => json(200, jobDetail({ status: 'completed' })),
    );
    await createClient(fetch).analyze(
      options({
        inputs: [
          { slotName: 'original', source: photoPath, contentType: 'image/jpeg' },
          { slotName: 'reference', source: Buffer.from('ref'), contentType: 'image/png', fileName: 'id.png' },
        ],
        parameters: { isSimilarityCheck: true },
      }),
    );
    expect(calls.map(describeCall).slice(1, 3)).toEqual(['PUT /jobs/101/input/original.media', 'PUT /jobs/101/input/reference.media']);
    expect(calls[2]?.headers).toMatchObject({ 'content-type': 'image/png', 'content-length': '3' });
    expect((calls[0]?.body as { parameters: unknown }).parameters).toEqual({ isSimilarityCheck: true });
  });

  it('forwards pageCount for PDF inputs', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
    );
    await createClient(fetch).submit({
      taskTypeId: '13',
      inputs: [{ slotName: 'original', source: Buffer.from('%PDF'), contentType: 'application/pdf', fileName: 'doc.pdf', pageCount: 3 }],
    });
    expect((calls[0]?.body as { inputs: { pageCount?: number }[] }).inputs[0]?.pageCount).toBe(3);
  });

  it('returns a failed job instead of throwing', async () => {
    const { fetch } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
      () => json(200, jobDetail({ status: 'failed', result: null })),
    );
    await expect(createClient(fetch).analyze(options())).resolves.toMatchObject({ job: { status: 'failed', result: null } });
  });

  it('throws JobTimeoutError from the wait step without cancelling the job', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
      ...Array.from({ length: 50 }, () => () => json(200, jobDetail({ status: 'queued' }))),
    );
    await expect(createClient(fetch).analyze(options({ polling: { intervalMs: 5, timeoutMs: 30 } }))).rejects.toBeInstanceOf(JobTimeoutError);
    expect(calls.some(call => call.url.endsWith('/cancel'))).toBe(false);
  });
});

describe('submit failure handling', () => {
  it('cancels the job when an upload fails and keeps the original error as cause', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => text(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>', 'application/xml'),
      () => json(200, job({ status: 'cancelled' })),
    );
    const error = (await createClient(fetch)
      .submit(options())
      .catch((e: unknown) => e)) as JobSubmissionError;

    expect(error).toBeInstanceOf(JobSubmissionError);
    expect(error).toMatchObject({ jobId: '101', stage: 'upload', code: 'JOB_SUBMISSION_FAILED' });
    expect(error.cause).toBeInstanceOf(UploadError);
    expect(error.cleanup).toMatchObject({ attempted: true, succeeded: true, job: { status: 'cancelled' } });
    expect(error.message).toContain('The job was cancelled.');
    expect(error.message).not.toMatch(/refund/i);
    expect(calls.map(describeCall)).toEqual(['POST /api/v1/jobs', 'PUT /jobs/101/input/original.media', 'POST /api/v1/jobs/101/cancel']);
  });

  it('preserves both errors when cancelling after an upload failure also fails', async () => {
    const { fetch } = mockFetch(
      () => json(201, createResponse()),
      () => text(500, 'storage down'),
      () => apiError(422, 'CANCEL_NOT_ALLOWED', 'Cancel not allowed'),
    );
    const error = (await createClient(fetch)
      .submit(options())
      .catch((e: unknown) => e)) as JobSubmissionError;

    expect(error.cause).toBeInstanceOf(UploadError);
    expect(error.cleanup.attempted).toBe(true);
    expect(error.cleanup.succeeded).toBe(false);
    expect(error.cleanup.error).toMatchObject({ code: 'CANCEL_NOT_ALLOWED' });
    expect(error.message).toContain('Cancelling the job also failed');
  });

  it('cancels when the upload URL has already expired', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse(['original'], { expiresInMs: -1 })),
      () => json(200, job({ status: 'cancelled' })),
    );
    const error = (await createClient(fetch)
      .submit(options())
      .catch((e: unknown) => e)) as JobSubmissionError;
    expect(error.cause).toBeInstanceOf(UploadUrlExpiredError);
    expect(calls.map(describeCall)).toEqual(['POST /api/v1/jobs', 'POST /api/v1/jobs/101/cancel']);
  });

  it('cancels when finalize reports a missing upload', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => apiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found'),
      () => json(200, job({ status: 'cancelled' })),
    );
    const error = (await createClient(fetch)
      .submit(options())
      .catch((e: unknown) => e)) as JobSubmissionError;
    expect(error).toMatchObject({ stage: 'finalize', cleanup: { succeeded: true } });
    expect(error.cause).toMatchObject({ constructor: NotFoundError, code: 'UPLOAD_NOT_FOUND' });
    expect(calls).toHaveLength(4);
  });

  it('treats an ambiguous finalize as success when the job turns out to be queued', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      networkFailure('ECONNRESET'),
      () => json(200, jobDetail({ status: 'queued' })),
    );
    await expect(createClient(fetch).submit(options())).resolves.toMatchObject({ job: { status: 'queued' } });
    expect(calls.some(call => call.url.endsWith('/cancel'))).toBe(false);
  });

  it('cancels when an ambiguous finalize left the job initiated', async () => {
    const { fetch } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      hang(),
      () => json(200, jobDetail({ status: 'initiated' })),
      () => json(200, job({ status: 'cancelled' })),
    );
    const error = (await createClient(fetch, { timeoutMs: 30 })
      .submit(options())
      .catch((e: unknown) => e)) as JobSubmissionError;
    expect(error).toMatchObject({ stage: 'finalize', cleanup: { succeeded: true } });
    expect(error.cause).toBeInstanceOf(RequestTimeoutError);
  });

  it('accepts a finalize 409 when the job was already queued', async () => {
    const { fetch } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => apiError(409, 'UPLOAD_ALREADY_FINALIZED', 'Already finalized'),
      () => json(200, jobDetail({ status: 'queued' })),
    );
    await expect(createClient(fetch).submit(options())).resolves.toMatchObject({ job: { status: 'queued' } });
  });

  it('leaves the job alone when cancelOnFailure is false', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => text(500, 'storage down'),
    );
    const error = (await createClient(fetch)
      .submit(options({ cancelOnFailure: false }))
      .catch((e: unknown) => e)) as JobSubmissionError;
    expect(error.cleanup).toEqual({ attempted: false, succeeded: false });
    expect(calls).toHaveLength(2);
  });

  it('cancels with a fresh signal when the caller aborts mid-upload', async () => {
    const controller = new AbortController();
    const reason = new Error('user aborted');
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      call => {
        setTimeout(() => controller.abort(reason), 5);
        return hang()(call);
      },
      () => json(200, job({ status: 'cancelled' })),
    );
    const error = (await createClient(fetch)
      .submit(options({ signal: controller.signal }))
      .catch((e: unknown) => e)) as JobSubmissionError;

    expect(error).toBeInstanceOf(JobSubmissionError);
    expect(error.cause).toBe(reason);
    expect(error.cleanup.succeeded).toBe(true);
    expect(calls[2]?.signal?.aborted).toBe(false);
  });

  it('reports a missing upload target for a slot and cleans up', async () => {
    const { fetch } = mockFetch(
      () => json(201, createResponse(['something-else'])),
      () => json(200, job({ status: 'cancelled' })),
    );
    const error = (await createClient(fetch)
      .submit(options())
      .catch((e: unknown) => e)) as JobSubmissionError;
    expect(error.cause).toBeInstanceOf(InvalidResponseError);
    expect(error.cleanup.succeeded).toBe(true);
  });

  it('does not upload, cancel or retry when job creation is uncertain', async () => {
    const { fetch, calls } = mockFetch(networkFailure('ECONNRESET'));
    await expect(createClient(fetch).submit(options())).rejects.toBeInstanceOf(JobCreationUncertainError);
    expect(calls).toHaveLength(1);
  });

  it('requires fileName for in-memory sources before sending anything', async () => {
    const { fetch, calls } = mockFetch();
    await expect(
      createClient(fetch).submit(options({ inputs: [{ slotName: 'original', source: Buffer.from('x'), contentType: 'image/jpeg' }] })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty input list before sending anything', async () => {
    const { fetch, calls } = mockFetch();
    await expect(createClient(fetch).submit(options({ inputs: [] }))).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });
});
