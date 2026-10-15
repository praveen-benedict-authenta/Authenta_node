# @authentadev/node

Official Node.js SDK for [Authenta](https://authenta.ai): detect AI-generated, deepfake and tampered media from your server.

Upload an image, video, audio file or PDF, pick a model, and get the detection result. The SDK handles job creation, secure uploads, processing status and result retrieval for you.

- Node.js 18, 20 and 22
- TypeScript types included; works with `require` and `import`
- No runtime dependencies
- **Server-side only.** Never put your API key in a browser or mobile app.

## Installation

```bash
npm install @authentadev/node
```

## Quick start

```ts
import { AuthentaClient } from '@authentadev/node';

const client = new AuthentaClient({ apiKey: process.env.AUTHENTA_API_KEY! });

const { job } = await client.process('./photo.jpg', { model: 'AC-1' });

if (job.status === 'completed') {
  const result = await client.getResult(job);
  console.log(result);
} else {
  console.log(`Job ${job.id} ended with status: ${job.status}`);
}
```

`process()` uploads the file, starts processing, waits until the job finishes and returns it. A finished job is `completed`, `failed` or `cancelled`, so always check `job.status`.

Using CommonJS:

```js
const { AuthentaClient } = require('@authentadev/node');
```

## Getting an API key

Create an API key in the Authenta console under **Settings → API Keys**. Store it in an environment variable or a secret manager; don't hard-code it.

```bash
export AUTHENTA_API_KEY="api_..."
```

## Configuration

```ts
const client = new AuthentaClient({
  apiKey: process.env.AUTHENTA_API_KEY!,   // required
  baseUrl: 'https://platform.authenta.ai', // optional, this is the default
  timeoutMs: 30_000,                       // per API request
  uploadTimeoutMs: 600_000,                // per file upload or download
  maxRetries: 2,                           // automatic retries for read requests
  retryDelayMs: 500,                       // base delay between retries
});
```

Only `apiKey` is required. Set `baseUrl` when your organization uses a dedicated or on-premises Authenta deployment.

## Models

Choose a model with `model`. It decides what Authenta checks in your file.

| Model | What it detects | Accepted files |
|---|---|---|
| `AC-1` | AI-generated images | jpg, png |
| `FD-1` | Forged or edited images | jpg, png |
| `DI-1` | Forged documents (photo or scan) | jpg, png |
| `FL-1` | Face liveness (real face vs. spoof) | jpg, png |
| `FE-1` | Face embedding (face vector) | jpg, png |
| `FI-1` | Face intelligence: liveness, face swap, face match | jpg, png, mp4, webm, mov |
| `VF-1` | AI-generated video | mp4, mov |
| `DF-1` | Face swap (deepfake) video | mp4, mov, webm |
| `ED-1` | Deepfakes in eKYC videos | mp4, mov, webm |
| `AF-1` | AI-generated audio | mp3, wav, m4a |
| `AS-1` | Audio splitting (voice and background) | mp3, wav, m4a |
| `PDF-1` | Tampered PDF documents | pdf |

The SDK sets the correct file type for the model automatically. A file the model doesn't accept is rejected before anything is uploaded or charged:

```ts
await client.process('./clip.mp4', { model: 'AC-1' });
// ValidationError: Model AC-1 (slot "original") does not accept "clip.mp4". Accepted file types: jpg, jpeg, png
```

If your Authenta account manager gives you a different model configuration, pass it once when creating the client:

```ts
const client = new AuthentaClient({ apiKey, models: { 'PDF-1': '<id from Authenta>' } });
```

## Common tasks

### Detect an AI-generated or edited image

```ts
const { job } = await client.process('./photo.jpg', { model: 'AC-1' });
const result = await client.getResult(job);
```

### Detect a deepfake video

```ts
const { job } = await client.process('./interview.mp4', { model: 'DF-1' });
```

Videos take longer to process. Raise the wait time if needed:

```ts
await client.process('./interview.mp4', { model: 'DF-1', polling: { timeoutMs: 30 * 60_000 } });
```

### Face intelligence (`FI-1`)

Turn on one or more checks:

```ts
// Is this a live person?
await client.process('./selfie.jpg', { model: 'FI-1', livenessCheck: true });

// Was the face swapped? (video only)
await client.process('./selfie-video.mp4', { model: 'FI-1', faceswapCheck: true });

// Is it the same person as on the ID? (image only, needs a reference photo)
await client.process('./selfie.jpg', {
  model: 'FI-1',
  faceSimilarityCheck: true,
  reference: './id-card.jpg',
});
```

At least one check must be enabled. `faceswapCheck` needs a video; `faceSimilarityCheck` needs an image and a `reference` image.

### Check a PDF for tampering

PDF checks are priced per page, so pass the number of pages:

```ts
await client.process('./contract.pdf', { model: 'PDF-1', pageCount: 4 });
```

### Extract a face embedding

```ts
const embedding = await client.extractFaceVector('./face.jpg');
```

### Upload from memory

Buffers, `Uint8Array`, `ArrayBuffer` and `Blob` work too. Give the file a name so its type can be detected:

```ts
const bytes = await fs.promises.readFile('./photo.jpg');
await client.process(bytes, { model: 'AC-1', fileName: 'photo.jpg' });
```

### Submit now, collect the result later

```ts
const { job } = await client.process('./video.mp4', { model: 'DF-1', wait: false });
saveJobId(job.id);

// later, for example in a background worker
const finished = await client.jobs.waitForCompletion(job.id);
const result = await client.getResult(finished);
```

## `process()` options

| Option | Default | Description |
|---|---|---|
| `model` | required | Model to run (see [Models](#models)) |
| `wait` | `true` | Wait for the result. `false` returns as soon as the job is queued |
| `polling` | | `{ intervalMs, timeoutMs, onStatusChange }`; see [Waiting for results](#waiting-for-results) |
| `fileName` | from path | Required when uploading from memory |
| `contentType` | detected | Override the detected file type |
| `pageCount` | | Required for `PDF-1` |
| `livenessCheck`, `faceswapCheck`, `faceSimilarityCheck` | `false` | `FI-1` checks |
| `reference` | | Reference image for `faceSimilarityCheck` |
| `signal` | | `AbortSignal` to stop the whole operation |
| `cancelOnFailure` | `true` | Cancel the job automatically if the upload fails |

## Results

When a job is `completed`, read the result with `getResult()`:

```ts
const result = await client.getResult(job);
```

It returns the model's full result as JSON. The fields depend on the model, so inspect the result for the model you use. `getResult()` throws `ValidationError` with `code: 'RESULT_NOT_AVAILABLE'` when there's no result, for example for a `failed` job.

A short summary is also available directly on the job as `job.result`.

### Files produced by a job

Some models produce extra files, such as heatmaps:

```ts
const job = await client.jobs.get(jobId);

for (const file of client.artifacts.list(job, 'heatmap')) {
  const bytes = await client.artifacts.download(file);
  await fs.promises.writeFile(`heatmap-${file.id}.png`, bytes);
}
```

Download links expire after a few minutes. If a download fails with `code: 'ARTIFACT_URL_EXPIRED'`, call `client.jobs.get(jobId)` again for fresh links.

## Waiting for results

```ts
const job = await client.jobs.waitForCompletion(jobId, {
  intervalMs: 5_000,     // how often to check (default 5 s)
  timeoutMs: 600_000,    // give up after (default 10 min)
  onStatusChange: (job, previous) => console.log(previous, '→', job.status),
});
```

| Status | Meaning |
|---|---|
| `initiated` | Job created, waiting for the file upload |
| `queued` | Upload done, waiting to be processed |
| `processing` | Being analyzed. It may return to `queued` if processing is retried |
| `completed` | Done; the result is available |
| `failed` | Processing failed |
| `cancelled` | Cancelled before processing started |

If the timeout passes, `JobTimeoutError` is thrown. The job keeps running, and `error.jobId` lets you check on it later. Pass an `AbortSignal` as `signal` to stop waiting at any time.

## Managing jobs

```ts
await client.jobs.get(jobId);       // status, result and files
await client.jobs.cancel(jobId);    // only before processing starts
await client.jobs.delete(jobId);    // delete a job and its files (not while processing)
```

### Listing jobs

```ts
const page = await client.jobs.list({ limit: 20, offset: 0, status: 'completed' });
console.log(page.total, page.data);

for await (const job of client.jobs.iterate({ createdAfter: new Date('2026-01-01') })) {
  console.log(job.id, job.status);
}
```

Filters: `status`, `createdAfter`, `createdBefore`. Jobs are returned newest first, with `limit` 1–100.

## Error handling

All errors extend `AuthentaError` and include:

| Property | Description |
|---|---|
| `message` | What went wrong |
| `code` | Error code, e.g. `JOB_NOT_FOUND`, `VALIDATION_ERROR` |
| `status` | HTTP status, when the error came from the API |
| `requestId` | Request ID. Include it when contacting Authenta support |
| `fields` | Field-level details for validation errors |
| `jobId` | The related job, when known |

| Error | When |
|---|---|
| `ValidationError` | Invalid input, unsupported file type, or the API rejected the request |
| `AuthenticationError` | Missing, invalid, revoked or expired API key |
| `InsufficientCreditsError` | Not enough credits |
| `AuthorizationError` | Not allowed |
| `NotFoundError` | Job not found |
| `ConflictError` | The action doesn't fit the job's current state |
| `QuotaExceededError` | Too many requests |
| `ServerError` | Authenta service error |
| `NetworkError`, `RequestTimeoutError` | Connection problems or a slow response |
| `JobCreationUncertainError` | The connection dropped while creating a job; it may or may not exist |
| `JobSubmissionError` | The job was created but the upload or start failed |
| `UploadError`, `UploadUrlExpiredError` | The file upload failed or its upload link expired |
| `JobTimeoutError` | The job did not finish within `timeoutMs` |
| `ArtifactDownloadError` | Downloading a result file failed |

```ts
import {
  AuthenticationError,
  InsufficientCreditsError,
  JobCreationUncertainError,
  JobSubmissionError,
  JobTimeoutError,
  ValidationError,
} from '@authentadev/node';

try {
  const { job } = await client.process('./photo.jpg', { model: 'AC-1' });
} catch (error) {
  if (error instanceof AuthenticationError) {
    // check your API key
  } else if (error instanceof InsufficientCreditsError) {
    // top up credits
  } else if (error instanceof ValidationError) {
    console.log(error.message, error.fields);
  } else if (error instanceof JobSubmissionError) {
    console.log(`Job ${error.jobId} could not start; cancelled: ${error.cleanup.succeeded}`, error.cause);
  } else if (error instanceof JobTimeoutError) {
    console.log(`Job ${error.jobId} is still running; check again later`);
  } else if (error instanceof JobCreationUncertainError) {
    // see below
  } else {
    throw error;
  }
}
```

### Creating a job is never retried

Creating a job uses credits, so the SDK never retries it automatically. If the connection drops while a job is being created, you get `JobCreationUncertainError`. List your recent jobs before trying again, so you don't create a duplicate:

```ts
const recent = await client.jobs.list({ createdAfter: startedAt });
```

### Failed uploads are cleaned up

If the file upload fails after a job was created, the SDK cancels that job and throws `JobSubmissionError`:
- `error.cause` is the original problem.
- `error.cleanup.succeeded` says whether the cancellation worked.

Upload links are short-lived, so uploads start immediately after the job is created. If a link expires, run `process()` again.

## Credits

Credits are used when a job is created. Reading jobs, listing, cancelling and deleting don't use credits. Check your balance and usage in the Authenta console under **Settings → Billing**.

## Advanced: step-by-step API

For full control you can run each step yourself:

```ts
// 1. Create the job
const created = await client.jobs.create({
  taskTypeId: client.resolveModel('AC-1'),
  inputs: [{ slotName: 'original', fileName: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: 48213 }],
});

// 2. Upload the file to the provided upload link (start right away)
await client.uploads.put(created.inputs[0]!, './photo.jpg', { contentType: 'image/jpeg', sizeBytes: 48213 });

// 3. Start processing
await client.jobs.finalize(created.job.id);

// 4. Wait for the result
const job = await client.jobs.waitForCompletion(created.job.id);
```

`client.submit()` and `client.analyze()` cover the same flow with more control over inputs:

```ts
await client.analyze({
  model: 'FI-1',
  inputs: [
    { slotName: 'original', source: './selfie.jpg' },
    { slotName: 'reference', source: './id-card.jpg' },
  ],
  parameters: { isSimilarityCheck: true },
});
```

## Requirements and limitations

- Node.js 18 or newer. Server-side use only.
- Results are delivered by polling; webhooks are not available.
- One job per file. For many files, call `process()` for each file.
- An expired upload link can't be renewed; run the job again.

## Development

```bash
npm install
npm run lint    # type-check
npm test        # unit tests (no network or API key needed)
npm run build   # compile to dist/
```

## License

MIT
