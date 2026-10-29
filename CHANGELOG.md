# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

### Added

- `AuthentaClient` with API key authentication, configurable base URL, request and upload timeouts, automatic retries for read requests, and an injectable `fetch`.
- `process(source, { model })`: upload a file, start processing and wait for the result in one call. Supports model codes (`AC-1`, `DF-1`, `FI-1`, `PDF-1`, …), face intelligence checks with a reference image, and `pageCount` for PDFs.
- `getResult(job)` and `extractFaceVector(source)`.
- `PDF-1` uses task type `13` on production (`PRODUCTION_BASE_URL`) and `12` elsewhere; see `PRODUCTION_MODEL_OVERRIDES`. Client `models` overrides still take precedence.
- `ScoredResult`, `ResultTag` and `TagBoundaries` types for the scored result fields, including `tag`, `tagBoundaries` and `modelVersion`.
- Automatic file type detection per model. Unsupported files are rejected before upload.
- Model configuration overrides through the client's `models` option.
- Jobs API: `jobs.create`, `jobs.get`, `jobs.list`, `jobs.iterate`, `jobs.finalize`, `jobs.cancel`, `jobs.delete`, `jobs.waitForCompletion`.
- `submit()` and `analyze()` for multi-input jobs, with automatic cancellation if an upload fails.
- `uploads.put` for file paths (streamed), Buffers, typed arrays, ArrayBuffers and Blobs.
- `artifacts.list`, `artifacts.download` and `artifacts.downloadJson`.
- Typed errors with `code`, `message`, `requestId` and `fields`.
- `JobCreationUncertainError` when job creation is interrupted; creation is never retried automatically.

### Removed

- `AS-1` (audio splitter). It is no longer a model code; `resolveModel('AS-1')` throws `UNKNOWN_MODEL`.
