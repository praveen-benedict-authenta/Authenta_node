/**
 * Entry point for the Authenta Jobs API.
 */

import { Workflow, type AnalyzeOptions, type AnalyzeResult, type ProcessOptions, type SubmitOptions, type SubmitResult } from './analyze';
import { ArtifactsResource } from './artifacts';
import { ValidationError } from './errors';
import { HttpClient } from './http';
import { JobsResource } from './jobs';
import { isImageType } from './mime';
import { buildModelTable, resolveModel, type ModelCode } from './models';
import { UploadsResource, type UploadSource } from './upload';
import type { CallOptions, FetchLike, JobDetail } from './types';
import { SDK_VERSION } from './version';

/** `process()` options without `model`, for helpers that fix the model. */
export type ExtractFaceVectorOptions = Omit<
  ProcessOptions,
  'model' | 'reference' | 'faceswapCheck' | 'livenessCheck' | 'faceSimilarityCheck' | 'referenceContentType' | 'referenceFileName' | 'wait'
>;

export const DEFAULT_BASE_URL = 'https://platform.authenta.ai';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 500;

export interface AuthentaClientOptions {
  /** API key (`api_…`), sent as `Authorization: Bearer <apiKey>`. Keep it server-side. */
  apiKey: string;
  /** Deployment origin, for example `https://platform.authenta.ai` or `http://localhost:8080`. */
  baseUrl?: string;
  /** Timeout for each API request. Default 30000 ms; `0` disables it. */
  timeoutMs?: number;
  /** Timeout for each file upload and artifact download. Default 600000 ms; `0` disables it. */
  uploadTimeoutMs?: number;
  /** Automatic retries for GET requests on network errors, timeouts, 429 and 502/503/504. Default 2. */
  maxRetries?: number;
  /** Base delay for exponential backoff between GET retries. Default 500 ms. */
  retryDelayMs?: number;
  /** Custom `fetch` implementation. Defaults to the global `fetch` (Node.js 18+). */
  fetch?: FetchLike;
  /** Overrides the `User-Agent` header sent to the API. */
  userAgent?: string;
  /**
   * Model code → task type ID overrides or additions, merged over `DEFAULT_MODELS` (and, on production,
   * `PRODUCTION_MODEL_OVERRIDES`). Use it when your deployment's IDs differ, e.g. `{ 'PDF-1': '<id>' }`.
   */
  models?: Record<string, string | number>;
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ValidationError(`baseUrl is not a valid URL: "${raw}"`, { code: 'INVALID_ARGUMENT' });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError('baseUrl must use http or https', { code: 'INVALID_ARGUMENT' });
  }
  if (url.search || url.hash) throw new ValidationError('baseUrl must not contain a query or fragment', { code: 'INVALID_ARGUMENT' });
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return `${url.origin}${path}`;
}

function nonNegative(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new ValidationError(`${label} must be a non-negative number`, { code: 'INVALID_ARGUMENT' });
  return value;
}

export class AuthentaClient {
  /** Low-level `/jobs` endpoints and polling. */
  readonly jobs: JobsResource;
  /** Presigned uploads. */
  readonly uploads: UploadsResource;
  /** Artifact listing and downloads. */
  readonly artifacts: ArtifactsResource;
  /** Origin the client talks to, without the `/api/v1` prefix. */
  readonly baseUrl: string;

  private readonly workflow: Workflow;
  private readonly modelTable: Record<string, string>;

  constructor(options: AuthentaClientOptions) {
    if (!options || typeof options.apiKey !== 'string' || !options.apiKey.trim()) {
      throw new ValidationError('apiKey is required', { code: 'INVALID_ARGUMENT' });
    }
    if (/\s/.test(options.apiKey)) throw new ValidationError('apiKey must not contain whitespace', { code: 'INVALID_ARGUMENT' });

    const fetchImpl = options.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
    if (!fetchImpl) throw new ValidationError('No fetch implementation found. Use Node.js 18+ or pass options.fetch', { code: 'INVALID_ARGUMENT' });

    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    const uploadTimeoutMs = nonNegative(options.uploadTimeoutMs, DEFAULT_UPLOAD_TIMEOUT_MS, 'uploadTimeoutMs');
    const http = new HttpClient({
      apiKey: options.apiKey,
      apiBaseUrl: `${this.baseUrl}/api/v1`,
      timeoutMs: nonNegative(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs'),
      maxRetries: Math.floor(nonNegative(options.maxRetries, DEFAULT_MAX_RETRIES, 'maxRetries')),
      retryDelayMs: nonNegative(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 'retryDelayMs'),
      fetch: fetchImpl,
      userAgent: options.userAgent ?? `authenta-node/${SDK_VERSION}`,
    });

    this.jobs = new JobsResource(http);
    this.uploads = new UploadsResource(fetchImpl, uploadTimeoutMs);
    this.artifacts = new ArtifactsResource(fetchImpl, uploadTimeoutMs);
    this.modelTable = buildModelTable(options.models, this.baseUrl);
    this.workflow = new Workflow(this.jobs, this.uploads, this.modelTable);
  }

  /** Task type ID for a model code, using this client's model table. Throws for unknown codes. */
  resolveModel(model: ModelCode): string {
    return resolveModel(model, this.modelTable);
  }

  /** The model codes this client knows, with their task type IDs. */
  get models(): Readonly<Record<string, string>> {
    return { ...this.modelTable };
  }

  /**
   * Upload one file for a model and (by default) wait for the result.
   *
   * @example await client.process('./photo.jpg', { model: 'AC-1' })
   * @example await client.process('./selfie.jpg', { model: 'FI-1', faceSimilarityCheck: true, reference: './id.jpg' })
   */
  process(source: UploadSource, options: ProcessOptions & { wait: false }): Promise<SubmitResult>;
  process(source: UploadSource, options: ProcessOptions & { wait?: true }): Promise<AnalyzeResult>;
  process(source: UploadSource, options: ProcessOptions): Promise<AnalyzeResult | SubmitResult>;
  process(source: UploadSource, options: ProcessOptions): Promise<AnalyzeResult | SubmitResult> {
    return this.workflow.process(source, options);
  }

  /**
   * Returns the result artifact's JSON when the job has one, otherwise
   * the job's inline `result`. Throws `ValidationError` (`RESULT_NOT_AVAILABLE`) when neither exists,
   * for example for failed, cancelled or unfinished jobs. The result is returned unvalidated.
   */
  async getResult(job: Pick<JobDetail, 'id' | 'status' | 'artifacts'> & { result?: unknown }, options: CallOptions = {}): Promise<unknown> {
    const artifact = job.artifacts.find(candidate => candidate.kind === 'result' && candidate.downloadUrl);
    if (artifact) return this.artifacts.downloadJson(artifact, options);
    if (job.result !== undefined && job.result !== null) return job.result;
    throw new ValidationError(`Job ${job.id} has no result (status "${job.status}")`, { code: 'RESULT_NOT_AVAILABLE', jobId: job.id });
  }

  /**
   * Runs `FE-1` on an image, waits, and returns the result (the face embedding) as raw JSON.
   * Non-image files are rejected before anything is uploaded.
   */
  async extractFaceVector(source: UploadSource, options: ExtractFaceVectorOptions = {}): Promise<unknown> {
    if (options.contentType !== undefined && !isImageType(options.contentType)) {
      throw new ValidationError('FE-1 only supports image input', { code: 'CONTENT_TYPE_NOT_ACCEPTED' });
    }
    const { job } = await this.process(source, { ...options, model: 'FE-1' });
    return this.getResult(job, options.signal === undefined ? {} : { signal: options.signal });
  }

  /**
   * Creates a job, uploads every input and finalizes it, without waiting for processing.
   * On upload or finalize failure the job is cancelled and `JobSubmissionError` is thrown.
   */
  submit(options: SubmitOptions): Promise<SubmitResult> {
    return this.workflow.submit(options);
  }

  /** `submit()` followed by `jobs.waitForCompletion()`. Resolves with a job in a terminal status. */
  analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
    return this.workflow.analyze(options);
  }
}
