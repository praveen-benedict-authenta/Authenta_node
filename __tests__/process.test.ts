import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ValidationError, type ProcessOptions } from '../src';
import { artifact, createResponse, job, jobDetail } from './helpers/fixtures';
import { apiError, createClient, empty, json, mockFetch, type RecordedCall } from './helpers/mock-fetch';

let dir: string;
let imagePath: string;
let referencePath: string;
let videoPath: string;
let pdfPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'authenta-node-process-'));
  imagePath = join(dir, 'selfie.jpg');
  referencePath = join(dir, 'id-card.png');
  videoPath = join(dir, 'clip.mp4');
  pdfPath = join(dir, 'contract.pdf');
  await Promise.all([
    writeFile(imagePath, Buffer.from('jpg!')),
    writeFile(referencePath, Buffer.from('png')),
    writeFile(videoPath, Buffer.from('mp4-bytes')),
    writeFile(pdfPath, Buffer.from('%PDF-1.7')),
  ]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const path = (call: RecordedCall | undefined): string => (call ? `${call.method} ${new URL(call.url).pathname}` : '');

describe('client.process', () => {
  it('runs a model code end to end like the Python SDK', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
      () => json(200, jobDetail({ status: 'completed', result: { isFake: true } })),
    );
    const { job: finished } = await createClient(fetch).process(imagePath, { model: 'AC-1', polling: { intervalMs: 1 } });

    expect(calls[0]?.body).toEqual({
      taskTypeId: '1',
      inputs: [{ slotName: 'original', fileName: 'selfie.jpg', contentType: 'image/jpeg', sizeBytes: 4 }],
    });
    expect(calls[1]?.headers['content-type']).toBe('image/jpeg');
    expect(finished.status).toBe('completed');
  });

  it('returns after finalize when wait is false (Python auto_polling=False)', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
    );
    const result = await createClient(fetch).process(videoPath, { model: 'DF-1', wait: false });
    expect(result.job.status).toBe('queued');
    expect(calls).toHaveLength(3);
  });

  it('sends FI-1 flags and the reference slot for a similarity check', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse(['original', 'reference'])),
      () => empty(200),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
    );
    await createClient(fetch).process(imagePath, { model: 'FI-1', faceSimilarityCheck: true, livenessCheck: true, reference: referencePath, wait: false });

    expect(calls[0]?.body).toEqual({
      taskTypeId: '8',
      inputs: [
        { slotName: 'original', fileName: 'selfie.jpg', contentType: 'image/jpeg', sizeBytes: 4 },
        { slotName: 'reference', fileName: 'id-card.png', contentType: 'image/png', sizeBytes: 3 },
      ],
      parameters: { isLivenessCheck: true, isSimilarityCheck: true },
    });
    expect(calls.map(path).slice(1, 3)).toEqual(['PUT /jobs/101/input/original.media', 'PUT /jobs/101/input/reference.media']);
  });

  it('sends only the enabled FI-1 flag for a video face swap check', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
    );
    await createClient(fetch).process(videoPath, { model: 'fi-1', faceswapCheck: true, wait: false });
    expect((calls[0]?.body as { parameters: unknown }).parameters).toEqual({ isFaceswapCheck: true });
  });

  it.each<[string, () => [string, Partial<ProcessOptions>]]>([
    ['face swap on an image', () => [imagePath, { faceswapCheck: true }]],
    ['similarity on a video', () => [videoPath, { faceSimilarityCheck: true, reference: referencePath }]],
    ['similarity without a reference', () => [imagePath, { faceSimilarityCheck: true }]],
    ['FI-1 with no check enabled', () => [imagePath, {}]],
  ])('rejects %s before sending (Python rules)', async (_label, build) => {
    const [source, extra] = build();
    const { fetch, calls } = mockFetch();
    await expect(createClient(fetch).process(source, { model: 'FI-1', ...extra })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a reference the API server would not accept (FI-1 references are jpg or png)', async () => {
    const { fetch, calls } = mockFetch();
    await expect(
      createClient(fetch).process(imagePath, { model: 'FI-1', faceSimilarityCheck: true, reference: videoPath }),
    ).rejects.toMatchObject({ code: 'CONTENT_TYPE_NOT_ACCEPTED' });
    expect(calls).toHaveLength(0);
  });

  it('rejects files the model does not accept before sending', async () => {
    const { fetch, calls } = mockFetch();
    await expect(createClient(fetch).process(videoPath, { model: 'AC-1' })).rejects.toMatchObject({ code: 'CONTENT_TYPE_NOT_ACCEPTED' });
    expect(calls).toHaveLength(0);
  });

  it('rejects face checks on models other than FI-1', async () => {
    const { fetch, calls } = mockFetch();
    await expect(createClient(fetch).process(imagePath, { model: 'AC-1', livenessCheck: true })).rejects.toThrow('only supported by model FI-1');
    expect(calls).toHaveLength(0);
  });

  it('requires pageCount for PDF-1 and forwards it when given', async () => {
    const missing = mockFetch();
    await expect(createClient(missing.fetch).process(pdfPath, { model: 'PDF-1' })).rejects.toMatchObject({ code: 'PAGE_COUNT_REQUIRED' });
    expect(missing.calls).toHaveLength(0);

    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
    );
    await createClient(fetch).process(pdfPath, { model: 'PDF-1', pageCount: 2, wait: false });
    expect(calls[0]?.body).toEqual({
      taskTypeId: '12',
      inputs: [{ slotName: 'original', fileName: 'contract.pdf', contentType: 'application/pdf', sizeBytes: 8, pageCount: 2 }],
    });
  });

  it('accepts an in-memory source with fileName', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
    );
    await createClient(fetch).process(Buffer.from('wav'), { model: 'AF-1', fileName: 'voice.wav', wait: false });
    expect((calls[0]?.body as { inputs: { contentType: string }[] }).inputs[0]?.contentType).toBe('audio/wav');
  });

  it('requires a model', async () => {
    const { fetch } = mockFetch();
    await expect(createClient(fetch).process(imagePath, {} as ProcessOptions)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('client.getResult', () => {
  it('downloads the result artifact JSON', async () => {
    const { fetch, calls } = mockFetch(() => json(200, { isDeepFake: false, faces: 1 }));
    const result = await createClient(fetch).getResult(
      jobDetail({ status: 'completed', artifacts: [artifact(), artifact({ id: '502', kind: 'result', downloadUrl: 'https://storage.example.test/r.json' })] }),
    );
    expect(result).toEqual({ isDeepFake: false, faces: 1 });
    expect(calls[0]?.url).toBe('https://storage.example.test/r.json');
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('falls back to the inline result when there is no result artifact', async () => {
    const { fetch, calls } = mockFetch();
    await expect(createClient(fetch).getResult(jobDetail({ status: 'completed', result: { isFake: true } }))).resolves.toEqual({ isFake: true });
    expect(calls).toHaveLength(0);
  });

  it.each(['failed', 'cancelled', 'processing'])('throws RESULT_NOT_AVAILABLE for a %s job without results', async status => {
    const { fetch } = mockFetch();
    await expect(createClient(fetch).getResult(jobDetail({ status, result: null }))).rejects.toMatchObject({
      constructor: ValidationError,
      code: 'RESULT_NOT_AVAILABLE',
      jobId: '101',
    });
  });
});

describe('client.extractFaceVector', () => {
  it('runs FE-1 and returns the embedding JSON', async () => {
    const embedding = { faceVector: [0.1, 0.2] };
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
      () =>
        json(
          200,
          jobDetail({ status: 'completed', artifacts: [artifact({ id: '9', kind: 'result', downloadUrl: 'https://storage.example.test/e.json' })] }),
        ),
      () => json(200, embedding),
    );
    await expect(createClient(fetch).extractFaceVector(imagePath, { polling: { intervalMs: 1 } })).resolves.toEqual(embedding);
    expect((calls[0]?.body as { taskTypeId: string }).taskTypeId).toBe('9');
  });

  it('rejects non-image input before sending', async () => {
    const { fetch, calls } = mockFetch();
    await expect(createClient(fetch).extractFaceVector(videoPath)).rejects.toThrow('FE-1 only supports image input');
    expect(calls).toHaveLength(0);
  });

  it('surfaces a failed FE-1 job as RESULT_NOT_AVAILABLE', async () => {
    const { fetch } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
      () => json(200, jobDetail({ status: 'failed', result: null })),
    );
    await expect(createClient(fetch).extractFaceVector(imagePath, { polling: { intervalMs: 1 } })).rejects.toMatchObject({
      code: 'RESULT_NOT_AVAILABLE',
    });
  });

  it('propagates API errors such as insufficient credits', async () => {
    const { fetch } = mockFetch(() => apiError(402, 'INSUFFICIENT_BALANCE', 'Insufficient balance'));
    await expect(createClient(fetch).extractFaceVector(imagePath)).rejects.toMatchObject({ status: 402 });
  });
});
