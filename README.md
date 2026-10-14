# @authenta/node

Node.js SDK for the [Authenta](https://authenta.ai) Jobs API. It creates a job, uploads media to presigned storage URLs, finalizes the job, and waits for the result.

- Node.js 18, 20 and 22
- TypeScript types included; CommonJS build that can also be imported from ES modules
- No runtime dependencies (uses the built-in `fetch`)
- Server-side only: never ship an API key to a browser or mobile app

> **Status: 0.1.0, pre-release.** Built against the Authenta API server's job endpoints. Models are selected with the same codes as the Authenta Python SDK (`AC-1`, `DF-1`, …). Their task type IDs, input slots and accepted file types come from the API server's task type configuration. See [Models](#models).

## Installation

```bash
npm install @authenta/node
```

## Quick start

```ts
import { AuthentaClient } from '@authenta/node';

const client = new AuthentaClient({ apiKey: process.env.AUTHENTA_API_KEY! });

// Same as the Python SDK: client.process("photo.jpg", model_type="AC-1")
const { job } = await client.process('./photo.jpg', { model: 'AC-1' });

if (job.status === 'completed') {
  console.log(await client.getResult(job)); // raw result JSON
} else {
  console.log(`Job ${job.id} ended as ${job.status}`); // 'failed' or 'cancelled'
}
```

`process()` uploads the file, finalizes the job and waits until it is `completed`, `failed` or `cancelled`. Always check `job.status`. The content type is guessed from the file extension, and the input slot defaults to `original`.

## Models

| Code | Task type ID | Slug | Model | Accepted files |
|---|---|---|---|---|
| `AC-1` | 1 | `ai-image-detection` | AI-generated image detection | jpg, png |
| `AF-1` | 2 | `ai-audio-detection` | AI-generated audio detection | mp3, wav, m4a |
| `VF-1` | 3 | `ai-video-detection` | AI-generated video detection | mp4, mov |
| `DF-1` | 4 | `faceswap-detection` | Face-swap (deepfake) video detection | mp4, mov, webm |
| `FD-1` | 5 | `image-forgery-detection` | Image forgery detection | jpg, png |
| `DI-1` | 6 | `document-intelligence` | Document forgery detection | jpg, png |
| `FL-1` | 7 | `face-liveness-detection` | Face liveness detection | jpg, png |
| `FI-1` | 8 | `face-intelligence` | Face intelligence: liveness, face swap, face similarity | jpg, png, mp4, webm, mov (+ jpg/png reference) |
| `FE-1` | 9 | `face-embedding` | Face embedding | jpg, png |
| `AS-1` | 10 | `audio-splitter` | Audio splitter | mp3, wav, m4a |
| `ED-1` | 11 | `ekyc-deepfake` | eKYC deepfake detection | mp4, mov, webm |
| `PDF-1` | 12 | `pdf-tampering-detection` | PDF tampering detection (needs `pageCount`) | pdf |

These values come from the Authenta API server's task type configuration (`authenta-api-server`, commit `45d73d4`). They are exported as `MODEL_SPECS`, with the bare code → ID map as `DEFAULT_MODELS`.

> PDF tampering is task type **12** on the API server. The Python SDK and the public documentation list 13; this SDK follows the API server.

If a deployment uses different IDs, override them:

```ts
const client = new AuthentaClient({ apiKey, models: { 'PDF-1': '13', 'MY-MODEL': '21' } });
client.resolveModel('PDF-1'); // '13'
```

You can always bypass codes with an explicit `taskTypeId` in `analyze()` / `submit()` / `jobs.create()`.

### `process(source, options)`

| Option | Default | Meaning |
|---|---|---|
| `model` | required | Model code |
| `wait` | `true` | `false` returns right after finalize (Python `auto_polling=False`) |
| `polling` | 5 s / 10 min | `{ intervalMs, timeoutMs, onStatusChange }` |
| `contentType` | guessed | Overrides the guess from the extension |
| `fileName` | file's name | Required for `Buffer` / `Blob` sources |
| `pageCount` | — | Required for `PDF-1` |
| `faceswapCheck`, `livenessCheck`, `faceSimilarityCheck` | `false` | `FI-1` only; at least one must be `true` |
| `reference` | — | Reference image for `faceSimilarityCheck` (sent as slot `reference`) |
| `signal`, `cancelOnFailure` | — | As in `analyze()` |

`FI-1` follows the Python SDK's rules, checked before any request:
- `faceswapCheck` needs a video.
- `faceSimilarityCheck` needs an image and a `reference`.

```ts
await client.process('./selfie.jpg', { model: 'FI-1', livenessCheck: true });
await client.process('./clip.mp4', { model: 'FI-1', faceswapCheck: true });
await client.process('./selfie.jpg', { model: 'FI-1', faceSimilarityCheck: true, reference: './id.jpg' });
await client.process('./contract.pdf', { model: 'PDF-1', pageCount: 4 });
```

### `getResult(job)` and `extractFaceVector(source)`

`getResult(job)` downloads the job's `result` artifact JSON. When there is none, it returns the inline `job.result`. If neither exists (for example a failed job), it throws `ValidationError` with `code: 'RESULT_NOT_AVAILABLE'`.

`extractFaceVector('./face.jpg')` runs `FE-1` and returns the embedding JSON (Python `extract_face_vector`).

### Content types

With a model code, the SDK sends exactly the content type the API server accepts for that model:
- `.mov` is sent as `video/mov` for `VF-1`, `DF-1` and `ED-1`, but as `video/quicktime` for `FI-1`.
- `.m4a` is sent as `audio/m4a` for `AF-1` and `AS-1`.

A file type the model does not accept (for example a `.mp4` for `AC-1`) is rejected with `ValidationError` (`code: 'CONTENT_TYPE_NOT_ACCEPTED'`) before anything is uploaded or charged. The error lists the accepted file types.

With a raw `taskTypeId` (or a custom model code), a standard type is guessed instead:

| Extension | Content type |
|---|---|
| jpg, jpeg | `image/jpeg` |
| png | `image/png` |
| webp | `image/webp` |
| mp3 | `audio/mpeg` |
| wav | `audio/wav` |
| m4a | `audio/mp4` |
| mp4 | `video/mp4` |
| mov | `video/quicktime` |
| webm | `video/webm` |
| pdf | `application/pdf` |

Other extensions require an explicit `contentType`. An explicit `contentType` is always sent unchanged.

From an ES module:

```js
import { AuthentaClient } from '@authenta/node';
```

## Configuration

```ts
const client = new AuthentaClient({
  apiKey: 'api_…',                       // required
  baseUrl: 'https://platform.authenta.ai', // default; an on-prem origin such as http://localhost:8080 also works
  timeoutMs: 30_000,                      // per API request
  uploadTimeoutMs: 600_000,               // per upload and artifact download
  maxRetries: 2,                          // automatic retries for GET requests only
  retryDelayMs: 500,                      // base for exponential backoff
  fetch: customFetch,                     // optional, e.g. for proxies or tests
});
```

`baseUrl` is the origin. A trailing `/api/v1` is accepted and removed. The API key is sent as `Authorization: Bearer <apiKey>` on API requests only.

## Job lifecycle

```
create  ──►  upload each input  ──►  finalize  ──►  queued ──► processing ──► completed
(initiated)  (presigned PUT)          (queued)            ▲          │     └──► failed
                                                          └──────────┘ retried by the server
initiated / queued ──► cancelled (via cancel)
```

| Status | Meaning |
|---|---|
| `initiated` | Created; waiting for uploads and finalize |
| `queued` | Finalized; waiting for a worker |
| `processing` | A worker is running the model. It can return to `queued` if the server retries it |
| `completed` | Finished; `job.result` and artifacts are available |
| `failed` | Retries exhausted. The API does not return a failure reason |
| `cancelled` | Cancelled before processing started |

A job left `initiated` is cleaned up by the server after roughly 20 minutes. Fetching it afterwards returns `NotFoundError`.

## Low-level API

```ts
// Create: returns { job, inputs: [{ slotName, uploadUrl, uploadUrlExpiresAt }] }
const created = await client.jobs.create({
  taskTypeId: '1',
  inputs: [{ slotName: 'original', fileName: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: 48213 }],
});

// Upload each input straight to storage
await client.uploads.put(created.inputs[0]!, './photo.jpg', { contentType: 'image/jpeg', sizeBytes: 48213 });

// Finalize: returns the job, normally `queued`
await client.jobs.finalize(created.job.id);

// Poll until completed, failed or cancelled
const job = await client.jobs.waitForCompletion(created.job.id, {
  intervalMs: 5_000,
  timeoutMs: 600_000,
  signal: AbortSignal.timeout(15 * 60_000),
  onStatusChange: (current, previous) => console.log(previous, '→', current.status),
});

await client.jobs.get(jobId);     // job + raw result + artifacts
await client.jobs.cancel(jobId);  // only while initiated or queued
await client.jobs.delete(jobId);  // not while processing
```

Job IDs are numeric strings (`"101"`). Numbers and bigints are accepted too. Anything else is rejected locally with `ValidationError` before a request is sent.

### Listing jobs

The API uses limit/offset pagination and returns jobs newest first.

```ts
const page = await client.jobs.list({ limit: 20, offset: 0, status: 'completed' });
// { limit, offset, total, data: Job[] }

for await (const job of client.jobs.iterate({ taskTypeSlug: 'ai-image-detection' })) {
  console.log(job.id, job.status);
}
```

Filters: `status`, `taskTypeSlug`, `createdAfter`, `createdBefore` (Date or ISO string). `limit` is 1–100. Because pagination is offset-based, jobs created while you iterate can appear twice.

### Submitting without waiting

`client.submit(options)` does create → upload → finalize and returns `{ created, job }`. You can then poll later with `jobs.waitForCompletion(job.id)`.

## Uploads

- **Sources:** a file path (streamed from disk), `Buffer`, `Uint8Array`, `ArrayBuffer` or `Blob`. With in-memory sources in `analyze()`, `fileName` is required.
- **Headers:** the upload URL is signed for the declared `Content-Type` and byte length. The SDK sends exactly that `Content-Type` and `Content-Length`, and checks the source size against `sizeBytes` first.
- **No API key:** the upload goes directly to storage with no `Authorization` header. The signed URL is never included in error messages.
- **Expiry:** upload URLs are short-lived. The server sizes them to the file, with a minimum of about 30 seconds, so upload immediately after creating the job. An expired URL raises `UploadUrlExpiredError`. There is no endpoint to issue a new URL, so create a new job instead.
- **Content type:** with a model code, the SDK picks the exact type the model accepts (see [Content types](#content-types)). `uploads.put()` and `jobs.create()` take the content type you pass and do not guess.
- **PDFs:** page-priced task types (PDF tampering detection) require `pageCount` on the input. The SDK forwards it but cannot count pages; the server rejects the job with `ValidationError` if it is missing.

## Polling

`waitForCompletion` polls `GET /jobs/:id`:

- It stops on `completed`, `failed` or `cancelled`.
- Its defaults are a 5-second interval and a 10-minute timeout. The SDK chose these; the API doesn't publish guidance.
- Transient errors (network, timeouts, 429, 502/503/504) are retried by the HTTP layer.
- When the timeout passes, it throws `JobTimeoutError` with `lastJob`. The job keeps running on the server.
- An `AbortSignal` stops it immediately; the promise rejects with the signal's reason.

Processing can take a long time: workers may be starting up, and the server retries failed attempts. Choose a timeout that suits your task type.

## Results and artifacts

`job.result` is the raw JSON written by the processing worker. The SDK returns it **unvalidated** (`unknown`) because result schemas differ by task type and are not yet published as a stable contract. Failed jobs have no result.

```ts
const detail = await client.jobs.get(jobId);
for (const artifact of client.artifacts.list(detail, 'result')) {
  const json = await client.artifacts.downloadJson(artifact); // raw JSON
}
const heatmaps = client.artifacts.list(detail, 'heatmap');
const bytes = await client.artifacts.download(heatmaps[0]!);
```

Download URLs expire after a few minutes. If a download fails with `code: 'ARTIFACT_URL_EXPIRED'`, call `jobs.get()` again for fresh URLs.

## Errors

Every error extends `AuthentaError`. API errors keep the server's response:

| Property | Source |
|---|---|
| `status` | HTTP status |
| `code` | Backend error `name`, e.g. `JOB_NOT_FOUND`, `VALIDATION_ERROR` |
| `message` | Backend `message` |
| `requestId` | Backend `rid`. Include it when contacting support |
| `fields` | Field-level validation messages |
| `body` | Parsed (or truncated) response body |

| Class | When | Retry? |
|---|---|---|
| `ValidationError` | 400/413/422, or invalid arguments caught locally | No: fix the request |
| `AuthenticationError` | 401: missing, invalid, revoked or expired key | No |
| `InsufficientCreditsError` | 402: balance or pay-as-you-go limit | No: top up |
| `AuthorizationError` | 403 | No |
| `NotFoundError` | 404: job, task type or upload not found | No |
| `ConflictError` | 409, e.g. finalizing a job that cannot be finalized | No |
| `QuotaExceededError` | 429 (`retryAfterMs`) | GETs are retried automatically |
| `ServerError` | 5xx | GETs are retried on 502/503/504 |
| `NetworkError` | No response (`possiblySent` tells you whether the server may have received it) | GETs are retried |
| `RequestTimeoutError` | API request timed out | GETs are retried |
| `InvalidResponseError` | Unparseable or unexpected response | No |
| `JobCreationUncertainError` | Job creation may or may not have happened | See below |
| `UploadError` / `UploadUrlExpiredError` | Upload to storage failed or URL expired | New job needed |
| `JobSubmissionError` | A created job failed during upload or finalize (`cause`, `cleanup`) | See below |
| `JobTimeoutError` | `waitForCompletion` timed out (`lastJob`) | Poll again later |
| `ArtifactDownloadError` | Artifact download failed | Refetch the job first |

### Job creation is never retried

Creating a job charges the wallet, and the API has no idempotency key. If the outcome is unknown, the SDK throws `JobCreationUncertainError` instead of retrying. That covers a dropped connection, a timeout, an abort after sending, or a 5xx (the server can commit the job before failing). Check `jobs.list({ createdAfter })` before creating it again.

### Failed submissions are cleaned up

If an upload or finalize fails after the job was created, `submit()` and `analyze()` try to cancel the job and then throw `JobSubmissionError`:

```ts
try {
  await client.analyze(options);
} catch (error) {
  if (error instanceof JobSubmissionError) {
    error.jobId;            // the job that was created
    error.stage;            // 'upload' | 'finalize'
    error.cause;            // the original failure
    error.cleanup.succeeded; // whether the cancel request succeeded
    error.cleanup.error;    // why the cancel failed, if it did
  }
}
```

Pass `cancelOnFailure: false` to skip the cancellation. Cleanup runs even if your `AbortSignal` caused the failure.

An ambiguous finalize failure (network error, timeout, 5xx) is checked against the job's state first. If the job is already queued, the submission succeeds. A `409` from `jobs.finalize()` is accepted only when the job is demonstrably finalized (`queued`, `processing`, `completed` or `failed`).

## Billing

Based on the Authenta API server's behaviour:

- **Charge time:** the cost is charged when the job is **created**, not when it is finalized.
- **Refunds:** the server reverses the charge when a job is cancelled or fails after exhausting retries. This SDK does not observe billing, so it never reports a refund. Check your billing history in the Authenta console.
- **Abandoned jobs:** a job left in `initiated` is cleaned up after about 20 minutes.

## Task configuration

Task type IDs, slot names and accepted content types are configured on the API server, and API keys cannot list them. The SDK therefore ships the API server's task type configuration as the [model table](#models), with overridable IDs. Each model uses the slot `original` (plus `reference` for `FI-1`), and content types are matched to what the model accepts.

For full control, use `analyze()` / `submit()` with explicit values:

```ts
await client.analyze({
  taskTypeId: '1',                          // or model: 'AC-1'
  inputs: [{ slotName: 'original', source, contentType: 'image/jpeg' }],
  parameters: { isLivenessCheck: true },    // face intelligence only
});
```

`parameters` accepts only the face intelligence flags (`isFaceswapCheck`, `isLivenessCheck`, `isSimilarityCheck`). The server drops any other keys.

## Limitations

These are not supported, because the API doesn't provide them:

- Webhooks
- Batch submission
- Listing task types with an API key
- Re-issuing expired upload URLs
- Failure reasons for failed jobs
- Idempotent job creation
- Browser use

Two Python SDK features are not included in this package:
- face indexing (`faceEnroll`, `faceSearch`, `tenants`)
- the OpenCV `visualization` helpers

Artifacts such as heatmaps can still be downloaded with `client.artifacts`.

## Examples

`examples/analyze.ts` (`process()` with a model code) and `examples/low-level.ts` (one call at a time) are runnable against a real deployment. They need `AUTHENTA_API_KEY` and, optionally, `AUTHENTA_BASE_URL`; `low-level.ts` also needs `AUTHENTA_TASK_TYPE_ID`. Run them with `npx ts-node`; ts-node is not a dependency of this package.

## Development

```bash
npm install
npm run lint    # strict type-check of src, tests and examples
npm test        # unit tests; no network or credentials needed
npm run build   # dist/ (CommonJS + .d.ts)
```

## License

MIT
