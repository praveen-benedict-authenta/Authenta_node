# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

### Added

- `AuthentaClient` with API key authentication, configurable base URL, request and upload timeouts, GET retries and injectable `fetch`.
- Jobs API: `jobs.create`, `jobs.get`, `jobs.list` (limit/offset), `jobs.iterate`, `jobs.finalize`, `jobs.cancel`, `jobs.delete`.
- `jobs.waitForCompletion` with interval, timeout, `AbortSignal` and `onStatusChange`. Terminal statuses are `completed`, `failed` and `cancelled`.
- `uploads.put` for presigned uploads from file paths (streamed), Buffers, typed arrays, ArrayBuffers and Blobs. It sends exact `Content-Type` and `Content-Length` and no API key.
- `submit()` (create → upload → finalize) and `analyze()` (submit + wait), with job cancellation and `JobSubmissionError` when a step fails after creation.
- `artifacts.list`, `artifacts.download` and `artifacts.downloadJson`.
- Typed errors that keep the backend's `name` (`code`), `message`, `rid` (`requestId`) and `fields`.
- `JobCreationUncertainError` for job creation whose outcome is unknown. Creation is never retried.
- Python SDK model codes (`AC-1` … `PDF-1`) mapped to the API server's task types (`MODEL_SPECS`, `DEFAULT_MODELS`), overridable with the client's `models` option. `model` is accepted by `submit()` and `analyze()`. PDF tampering is task type 12, as on the API server; the Python SDK and public docs list 13.
- `process(source, { model, … })`, `getResult(job)` and `extractFaceVector(source)`, mirroring the Python SDK. `process()` includes the FI-1 options and rules.
- Model-aware content types: the exact type the API server accepts for the model is sent (for example `.mov` → `video/mov` for DF-1, `video/quicktime` for FI-1). Unsupported file types and slots are rejected before any request. Standard guessing (`guessContentType`) applies to raw task type IDs. The default slot is `original`.
- `PDF-1` requires `pageCount` before any request is sent. The Python SDK never sends it.
