import type { ReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthentaClient, UploadError, UploadUrlExpiredError, ValidationError } from '../src';

interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface Reply {
  status: number;
  body?: string;
  contentType?: string;
  delayMs?: number;
}

let server: Server;
let origin: string;
let received: Received[] = [];
let replies: Reply[] = [];
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'authenta-node-upload-'));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      const reply = replies.shift() ?? { status: 200 };
      setTimeout(() => {
        res.writeHead(reply.status, reply.contentType ? { 'content-type': reply.contentType } : {});
        res.end(reply.body ?? '');
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  received = [];
  replies = [];
});

/** Uses the real global fetch so the assertions cover what actually goes on the wire. */
function client(): AuthentaClient {
  return new AuthentaClient({ apiKey: 'api_must_not_leak', baseUrl: 'https://api.example.test' });
}

function target(expiresInMs = 60_000) {
  return {
    slotName: 'original',
    uploadUrl: `${origin}/jobs/101/input/original.media?X-Amz-Signature=secret-signature`,
    uploadUrlExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

const bytes = Buffer.from('authenta-upload-payload-✓');

describe('uploads.put wire format', () => {
  async function expectExactUpload(source: Parameters<AuthentaClient['uploads']['put']>[1], expected: Buffer) {
    const result = await client().uploads.put(target(), source, { contentType: 'image/jpeg', sizeBytes: expected.byteLength });
    expect(result).toEqual({ status: 200, sizeBytes: expected.byteLength });

    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.method).toBe('PUT');
    expect(request?.url).toBe('/jobs/101/input/original.media?X-Amz-Signature=secret-signature');
    expect(request?.headers['content-type']).toBe('image/jpeg');
    expect(request?.headers['content-length']).toBe(String(expected.byteLength));
    expect(request?.headers['transfer-encoding']).toBeUndefined();
    expect(request?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(request?.headers)).not.toContain('api_must_not_leak');
    expect(request?.body.equals(expected)).toBe(true);
  }

  it('streams a file path with an exact Content-Length and no Authorization header', async () => {
    const path = join(tempDir, 'photo.jpg');
    await writeFile(path, bytes);
    await expectExactUpload(path, bytes);
  });

  it('uploads a Buffer', async () => {
    await expectExactUpload(bytes, bytes);
  });

  it('uploads only the visible window of a Uint8Array view', async () => {
    const backing = Buffer.concat([Buffer.from('HEADER'), bytes, Buffer.from('TRAILER')]);
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 6, bytes.byteLength);
    await expectExactUpload(view, bytes);
  });

  it('uploads an ArrayBuffer', async () => {
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await expectExactUpload(arrayBuffer, bytes);
  });

  it('uploads a Blob', async () => {
    await expectExactUpload(new Blob([bytes]), bytes);
  });

  it('streams a large file without changing its bytes', async () => {
    const large = Buffer.alloc(3 * 1024 * 1024 + 7, 0x61);
    const path = join(tempDir, 'large.bin');
    await writeFile(path, large);
    await expectExactUpload(path, large);
  });

  it('accepts 204 from on-prem local storage', async () => {
    replies.push({ status: 204 });
    await expect(client().uploads.put(target(), bytes, { contentType: 'image/jpeg' })).resolves.toMatchObject({ status: 204 });
  });
});

describe('uploads.put validation and failures', () => {
  it('rejects a source whose size differs from the declared sizeBytes, before sending', async () => {
    await expect(client().uploads.put(target(), bytes, { contentType: 'image/jpeg', sizeBytes: 1 })).rejects.toMatchObject({
      constructor: ValidationError,
      code: 'SIZE_MISMATCH',
    });
    expect(received).toHaveLength(0);
  });

  it('rejects an already-expired upload URL without sending', async () => {
    const error = await client()
      .uploads.put(target(-1000), bytes, { contentType: 'image/jpeg' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadUrlExpiredError);
    expect((error as UploadUrlExpiredError).slotName).toBe('original');
    expect(received).toHaveLength(0);
  });

  it('maps a storage "Request has expired" 403 to UploadUrlExpiredError', async () => {
    replies.push({
      status: 403,
      contentType: 'application/xml',
      body: '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>',
    });
    await expect(client().uploads.put(target(), bytes, { contentType: 'image/jpeg' })).rejects.toMatchObject({
      constructor: UploadUrlExpiredError,
      status: 403,
      code: 'UPLOAD_URL_EXPIRED',
    });
  });

  it('maps an on-prem 410 UPLOAD_EXPIRED to UploadUrlExpiredError', async () => {
    replies.push({ status: 410, contentType: 'application/json', body: JSON.stringify({ name: 'UPLOAD_EXPIRED', message: 'expired' }) });
    await expect(client().uploads.put(target(), bytes, { contentType: 'image/jpeg' })).rejects.toBeInstanceOf(UploadUrlExpiredError);
  });

  it('reports a signature mismatch as UploadError with the storage error code', async () => {
    replies.push({
      status: 403,
      contentType: 'application/xml',
      body: '<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match</Message></Error>',
    });
    const error = await client()
      .uploads.put(target(), bytes, { contentType: 'image/png' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error).not.toBeInstanceOf(UploadUrlExpiredError);
    expect((error as UploadError).code).toBe('SignatureDoesNotMatch');
  });

  it('never includes the signed URL in error messages', async () => {
    replies.push({ status: 500, body: 'oops' });
    const error = (await client()
      .uploads.put(target(), bytes, { contentType: 'image/jpeg' })
      .catch((e: unknown) => e)) as UploadError;
    expect(error).toBeInstanceOf(UploadError);
    expect(error.message).not.toContain('secret-signature');
    expect(error.message).not.toContain(origin);
  });

  it('reports a connection failure as UploadError', async () => {
    const closed = createServer();
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));

    const error = await client()
      .uploads.put({ uploadUrl: `http://127.0.0.1:${port}/x` }, bytes, { contentType: 'image/jpeg' })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ constructor: UploadError, code: 'UPLOAD_NETWORK_ERROR' });
  });

  it('closes the file stream when an upload fails', async () => {
    const path = join(tempDir, 'leak-check.jpg');
    await writeFile(path, bytes);
    const opened: ReadStream[] = [];
    const failingFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      opened.push((init as { body: ReadStream }).body);
      throw new TypeError('fetch failed');
    };
    const sdk = new AuthentaClient({ apiKey: 'api_x', fetch: failingFetch });
    await expect(sdk.uploads.put(target(), path, { contentType: 'image/jpeg' })).rejects.toMatchObject({ code: 'UPLOAD_NETWORK_ERROR' });
    expect(opened).toHaveLength(1);
    expect(opened[0]?.destroyed).toBe(true);
  });

  it('times out slow uploads', async () => {
    replies.push({ status: 200, delayMs: 500 });
    await expect(client().uploads.put(target(), bytes, { contentType: 'image/jpeg', timeoutMs: 50 })).rejects.toMatchObject({
      constructor: UploadError,
      code: 'UPLOAD_TIMEOUT',
    });
  });

  it("rejects with the caller's abort reason", async () => {
    replies.push({ status: 200, delayMs: 500 });
    const controller = new AbortController();
    const reason = new Error('stop');
    const promise = client().uploads.put(target(), bytes, { contentType: 'image/jpeg', signal: controller.signal });
    setTimeout(() => controller.abort(reason), 20);
    await expect(promise).rejects.toBe(reason);
  });

  it.each([
    ['a missing contentType', { contentType: '' }],
    ['a directory path', { contentType: 'image/jpeg' }],
  ])('rejects %s', async (label, options) => {
    const source = label === 'a directory path' ? tempDir : bytes;
    await expect(client().uploads.put(target(), source, options)).rejects.toBeInstanceOf(ValidationError);
    expect(received).toHaveLength(0);
  });

  it('rejects a missing file path', async () => {
    await expect(client().uploads.put(target(), join(tempDir, 'missing.jpg'), { contentType: 'image/jpeg' })).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
    });
  });
});

describe('artifacts', () => {
  it('downloads artifact bytes and JSON without sending the API key', async () => {
    replies.push({ status: 200, contentType: 'application/json', body: '{"isFake":true}' });
    const artifact = { id: '9', downloadUrl: `${origin}/jobs/101/output/result.json?sig=1` };
    await expect(client().artifacts.downloadJson(artifact)).resolves.toEqual({ isFake: true });
    expect(received[0]?.headers.authorization).toBeUndefined();
  });

  it('reports an expired download URL', async () => {
    replies.push({ status: 403, body: '<Error><Code>AccessDenied</Code></Error>' });
    await expect(client().artifacts.download({ id: '9', downloadUrl: `${origin}/x` })).rejects.toMatchObject({ code: 'ARTIFACT_URL_EXPIRED' });
  });

  it('refuses artifacts that have no download URL yet', async () => {
    await expect(client().artifacts.download({ id: '9', downloadUrl: null })).rejects.toMatchObject({ code: 'ARTIFACT_NOT_READY' });
  });

  it('filters artifacts by kind', () => {
    const job = {
      artifacts: [
        { id: '1', kind: 'input', slotName: 'original', status: 'completed', contentType: 'image/jpeg', metadata: null, downloadUrl: null, createdAt: '' },
        { id: '2', kind: 'result', slotName: null, status: 'completed', contentType: 'application/json', metadata: null, downloadUrl: null, createdAt: '' },
      ],
    };
    expect(client().artifacts.list(job, 'result').map(a => a.id)).toEqual(['2']);
    expect(client().artifacts.list(job)).toHaveLength(2);
  });
});
