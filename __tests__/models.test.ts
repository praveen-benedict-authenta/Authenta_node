import { AuthentaClient, DEFAULT_MODELS, MODEL_SPECS, ValidationError, getModelSpec, guessContentType, resolveModel } from '../src';
import { createResponse, job } from './helpers/fixtures';
import { createClient, empty, json, mockFetch } from './helpers/mock-fetch';

describe('model codes', () => {
  it.each(Object.entries(DEFAULT_MODELS))('resolves %s to task type %s', (code, id) => {
    expect(resolveModel(code)).toBe(id);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(resolveModel(' df-1 ')).toBe('4');
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])('does not resolve the inherited property %s as a model', key => {
    expect(() => resolveModel(key)).toThrow(ValidationError);
    expect(getModelSpec(key)).toBeUndefined();
  });

  it('lists the valid models for an unknown code', () => {
    expect(() => resolveModel('XX-9')).toThrow(/Unknown model "XX-9". Valid models: AC-1, AF-1/);
    expect(() => resolveModel('XX-9')).toThrow(ValidationError);
  });

  it('applies client overrides and additions', () => {
    const { fetch } = mockFetch();
    const client = new AuthentaClient({ apiKey: 'api_x', fetch, models: { 'pdf-1': '13', 'CUSTOM-1': 42 } });
    expect(client.resolveModel('PDF-1')).toBe('13');
    expect(client.resolveModel('custom-1')).toBe('42');
    expect(client.resolveModel('AC-1')).toBe('1');
    expect(client.models['PDF-1']).toBe('13');
    expect(DEFAULT_MODELS['PDF-1']).toBe('12');
  });
});

describe('submit with a model code', () => {
  const source = Buffer.from('img');

  it('sends the mapped task type ID and default slot and content type', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
    );
    await createClient(fetch).submit({ model: 'DF-1', inputs: [{ source, fileName: 'clip.MP4' }] });
    expect(calls[0]?.body).toEqual({
      taskTypeId: '4',
      inputs: [{ slotName: 'original', fileName: 'clip.MP4', contentType: 'video/mp4', sizeBytes: 3 }],
    });
  });

  it('uses the overridden ID', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
    );
    await createClient(fetch, { models: { 'AC-1': '77' } }).submit({ model: 'AC-1', inputs: [{ source, fileName: 'a.png' }] });
    expect((calls[0]?.body as { taskTypeId: string }).taskTypeId).toBe('77');
  });

  it.each([
    ['both model and taskTypeId', { model: 'AC-1', taskTypeId: '1' }],
    ['neither model nor taskTypeId', {}],
    ['an unknown model', { model: 'NOPE' }],
  ])('rejects %s before sending', async (_label, choice) => {
    const { fetch, calls } = mockFetch();
    await expect(createClient(fetch).submit({ ...choice, inputs: [{ source, fileName: 'a.png' }] })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it('requires pageCount for PDF-1 before sending', async () => {
    const { fetch, calls } = mockFetch();
    await expect(createClient(fetch).submit({ model: 'pdf-1', inputs: [{ source, fileName: 'doc.pdf' }] })).rejects.toMatchObject({
      code: 'PAGE_COUNT_REQUIRED',
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['AC-1', 'scan.tiff'],
    ['AC-1', 'photo.webp'],
    ['AC-1', 'clip.mp4'],
    ['VF-1', 'clip.webm'],
    ['AF-1', 'song.flac'],
    ['PDF-1', 'scan.png'],
  ])('rejects a file type %s does not accept (%s) before sending', async (model, fileName) => {
    const { fetch, calls } = mockFetch();
    const error = await createClient(fetch)
      .submit({ model, inputs: [{ source, fileName, pageCount: 1 }] })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ constructor: ValidationError, code: 'CONTENT_TYPE_NOT_ACCEPTED' });
    expect((error as Error).message).toContain('Accepted file types');
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['DF-1', 'clip.mov', 'video/mov'],
    ['VF-1', 'clip.MOV', 'video/mov'],
    ['ED-1', 'clip.mov', 'video/mov'],
    ['FI-1', 'clip.mov', 'video/quicktime'],
    ['AF-1', 'voice.m4a', 'audio/m4a'],
    ['AS-1', 'mix.wav', 'audio/wav'],
    ['DF-1', 'clip.webm', 'video/webm'],
    ['FL-1', 'face.png', 'image/png'],
    ['PDF-1', 'doc.pdf', 'application/pdf'],
  ])('sends the exact type the model accepts: %s + %s → %s', async (model, fileName, expected) => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
    );
    await createClient(fetch).submit({ model, inputs: [{ source, fileName, pageCount: 1 }] });
    expect((calls[0]?.body as { inputs: { contentType: string }[] }).inputs[0]?.contentType).toBe(expected);
    expect(calls[1]?.headers['content-type']).toBe(expected);
  });

  it('rejects a slot the model does not define', async () => {
    const { fetch, calls } = mockFetch();
    await expect(
      createClient(fetch).submit({ model: 'AC-1', inputs: [{ source, fileName: 'a.png', slotName: 'reference' }] }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_SLOT' });
    expect(calls).toHaveLength(0);
  });

  it('guesses a standard type for taskTypeId and custom model codes', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
    );
    const client = createClient(fetch, { models: { 'CUSTOM-1': '40' } });
    await client.submit({ taskTypeId: '3', inputs: [{ source, fileName: 'clip.mov' }] });
    await client.submit({ model: 'custom-1', inputs: [{ source, fileName: 'clip.mov' }] });
    expect((calls[0]?.body as { inputs: { contentType: string }[] }).inputs[0]?.contentType).toBe('video/quicktime');
    expect((calls[3]?.body as { taskTypeId: string; inputs: { contentType: string }[] }).taskTypeId).toBe('40');
    expect((calls[3]?.body as { inputs: { contentType: string }[] }).inputs[0]?.contentType).toBe('video/quicktime');
  });

  it('requires contentType when no model is known and the extension is unknown', async () => {
    const { fetch, calls } = mockFetch();
    await expect(createClient(fetch).submit({ taskTypeId: '1', inputs: [{ source, fileName: 'scan.tiff' }] })).rejects.toMatchObject({
      code: 'CONTENT_TYPE_REQUIRED',
    });
    expect(calls).toHaveLength(0);
  });

  it('lets an explicit contentType win over the guess', async () => {
    const { fetch, calls } = mockFetch(
      () => json(201, createResponse()),
      () => empty(200),
      () => json(200, job({ status: 'queued' })),
    );
    await createClient(fetch).submit({ model: 'DF-1', inputs: [{ source, fileName: 'clip.mov', contentType: 'video/mov' }] });
    expect((calls[0]?.body as { inputs: { contentType: string }[] }).inputs[0]?.contentType).toBe('video/mov');
  });
});

describe('MODEL_SPECS', () => {
  it('defines the expected task types and slots', () => {
    expect(Object.fromEntries(Object.entries(MODEL_SPECS).map(([code, spec]) => [code, spec.slug]))).toEqual({
      'AC-1': 'ai-image-detection',
      'AF-1': 'ai-audio-detection',
      'VF-1': 'ai-video-detection',
      'DF-1': 'faceswap-detection',
      'FD-1': 'image-forgery-detection',
      'DI-1': 'document-intelligence',
      'FL-1': 'face-liveness-detection',
      'FI-1': 'face-intelligence',
      'FE-1': 'face-embedding',
      'AS-1': 'audio-splitter',
      'ED-1': 'ekyc-deepfake',
      'PDF-1': 'pdf-tampering-detection',
    });
    expect(MODEL_SPECS['FI-1'].slots).toEqual({
      original: ['image/jpeg', 'image/png', 'video/mp4', 'video/webm', 'video/quicktime'],
      reference: ['image/jpeg', 'image/png'],
    });
    expect(getModelSpec('df-1')?.slots.original).toEqual(['video/mp4', 'video/mov', 'video/webm']);
    expect(getModelSpec('CUSTOM')).toBeUndefined();
  });
});

describe('guessContentType', () => {
  it.each([
    ['photo.jpg', 'image/jpeg'],
    ['photo.JPEG', 'image/jpeg'],
    ['a.png', 'image/png'],
    ['a.webp', 'image/webp'],
    ['a.mp3', 'audio/mpeg'],
    ['a.wav', 'audio/wav'],
    ['a.m4a', 'audio/mp4'],
    ['a.mp4', 'video/mp4'],
    ['a.mov', 'video/quicktime'],
    ['a.webm', 'video/webm'],
    ['C:\\docs\\contract.pdf', 'application/pdf'],
    ['/tmp/dir.v2/file.png', 'image/png'],
  ])('maps %s to %s', (name, type) => {
    expect(guessContentType(name)).toBe(type);
  });

  it.each(['scan.tiff', 'noextension', '.hidden', 'dir.d/file'])('returns undefined for %s', name => {
    expect(guessContentType(name)).toBeUndefined();
  });
});
