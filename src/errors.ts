/**
 * Error hierarchy for the SDK.
 *
 * API errors keep the server's error body intact: the backend returns `{ rid, name, message, fields? }`,
 * which surfaces here as `code` (backend `name`), `message`, `requestId` (backend `rid`) and `fields`.
 */

import type { Job } from './types';

export interface FieldError {
  field: string;
  msg: string;
}

export interface AuthentaErrorOptions {
  status?: number;
  code?: string;
  requestId?: string;
  fields?: FieldError[];
  body?: unknown;
  jobId?: string;
  cause?: unknown;
}

/** Base class for every error thrown by this SDK. */
export class AuthentaError extends Error {
  /** HTTP status, when the error came from an HTTP response. */
  readonly status?: number;
  /** Backend error name (for example `JOB_NOT_FOUND`), or an SDK code for local errors. */
  readonly code?: string;
  /** Backend request ID (`rid`). Include it when reporting a problem to Authenta. */
  readonly requestId?: string;
  /** Field-level validation messages from the backend. */
  readonly fields?: readonly FieldError[];
  /** Parsed (or truncated raw) response body. */
  readonly body?: unknown;
  /** Job the error relates to, when known. */
  readonly jobId?: string;

  constructor(message: string, options: AuthentaErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    if (options.status !== undefined) this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.fields !== undefined) this.fields = options.fields;
    if (options.body !== undefined) this.body = options.body;
    if (options.jobId !== undefined) this.jobId = options.jobId;
  }
}

/** 401: missing, invalid, revoked or expired API key. */
export class AuthenticationError extends AuthentaError {}

/** 402: not enough credits, or the pay-as-you-go limit was reached. */
export class InsufficientCreditsError extends AuthentaError {}

/** 403: authenticated but not allowed. */
export class AuthorizationError extends AuthentaError {}

/** 404: job, task type or upload not found. */
export class NotFoundError extends AuthentaError {}

/** 409: the request conflicts with the current job state. */
export class ConflictError extends AuthentaError {}

/** 400, 413 or 422 from the API, or invalid arguments rejected before any request is sent. */
export class ValidationError extends AuthentaError {}

/** 429: rate limited. */
export class QuotaExceededError extends AuthentaError {
  /** Delay requested by the server's `Retry-After` header, if present. */
  readonly retryAfterMs?: number;

  constructor(message: string, options: AuthentaErrorOptions & { retryAfterMs?: number } = {}) {
    super(message, options);
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/** 5xx from the API. */
export class ServerError extends AuthentaError {}

/** The request could not be completed at the network level (no HTTP response). */
export class NetworkError extends AuthentaError {
  /**
   * `false` only when the failure proves the request never reached the server (for example DNS
   * failure or connection refused). Otherwise the server may have processed it.
   */
  readonly possiblySent: boolean;

  constructor(message: string, options: AuthentaErrorOptions & { possiblySent: boolean }) {
    super(message, options);
    this.possiblySent = options.possiblySent;
  }
}

/** The request exceeded its timeout. */
export class RequestTimeoutError extends AuthentaError {}

/** The API answered with a body this SDK could not parse or that is missing required fields. */
export class InvalidResponseError extends AuthentaError {}

/**
 * Job creation may or may not have succeeded. Creating a job uses credits, so this SDK never retries
 * creation. Check `jobs.list({ createdAfter })` before creating the job again.
 */
export class JobCreationUncertainError extends AuthentaError {}

/** Uploading to a presigned URL failed. */
export class UploadError extends AuthentaError {
  /** Slot the upload was for. */
  readonly slotName?: string;

  constructor(message: string, options: AuthentaErrorOptions & { slotName?: string } = {}) {
    super(message, options);
    if (options.slotName !== undefined) this.slotName = options.slotName;
  }
}

/** The presigned upload URL had already expired. A new job is required to get a new URL. */
export class UploadUrlExpiredError extends UploadError {}

/** Downloading an artifact from its signed URL failed. Fetch the job again for a fresh URL. */
export class ArtifactDownloadError extends AuthentaError {}

/** `waitForCompletion` reached its timeout before the job reached a terminal status. */
export class JobTimeoutError extends AuthentaError {
  /** The last job state observed before timing out. */
  readonly lastJob: Job;

  constructor(message: string, lastJob: Job, options: AuthentaErrorOptions = {}) {
    super(message, { ...options, jobId: lastJob.id });
    this.lastJob = lastJob;
  }
}

/** Outcome of the best-effort cleanup performed after a failed submission. */
export interface CleanupResult {
  /** Whether the SDK attempted to cancel the job. */
  attempted: boolean;
  /** Whether the cancellation request succeeded. */
  succeeded: boolean;
  /** The job as returned by the cancel endpoint, when it succeeded. */
  job?: Job;
  /** The error raised by the cancel request, when it failed. */
  error?: unknown;
}

/**
 * A job was created but could not be uploaded or finalized. The original error is `cause`; the
 * outcome of the cancellation attempt is `cleanup`. Check your billing records for credit details.
 */
export class JobSubmissionError extends AuthentaError {
  readonly stage: 'upload' | 'finalize';
  readonly cleanup: CleanupResult;

  constructor(
    message: string,
    options: AuthentaErrorOptions & { jobId: string; stage: 'upload' | 'finalize'; cleanup: CleanupResult },
  ) {
    super(message, options);
    this.stage = options.stage;
    this.cleanup = options.cleanup;
  }
}

interface ApiErrorBody {
  rid?: unknown;
  name?: unknown;
  message?: unknown;
  fields?: unknown;
}

function isFieldErrorArray(value: unknown): value is FieldError[] {
  return (
    Array.isArray(value) &&
    value.every(item => typeof item === 'object' && item !== null && typeof (item as FieldError).field === 'string')
  );
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

/** Builds the matching typed error for a non-2xx API response. */
export function errorFromResponse(status: number, body: unknown, headers?: Headers): AuthentaError {
  const data: ApiErrorBody = typeof body === 'object' && body !== null ? (body as ApiErrorBody) : {};
  const code = typeof data.name === 'string' ? data.name : undefined;
  const serverMessage = typeof data.message === 'string' ? data.message : undefined;
  const message = serverMessage ?? `Authenta API request failed with HTTP ${status}`;

  const options: AuthentaErrorOptions = { status, body };
  if (code !== undefined) options.code = code;
  if (typeof data.rid === 'string') options.requestId = data.rid;
  if (isFieldErrorArray(data.fields)) options.fields = data.fields;

  switch (status) {
    case 400:
    case 413:
    case 422:
      return new ValidationError(message, options);
    case 401:
      return new AuthenticationError(message, options);
    case 402:
      return new InsufficientCreditsError(message, options);
    case 403:
      return new AuthorizationError(message, options);
    case 404:
      return new NotFoundError(message, options);
    case 409:
      return new ConflictError(message, options);
    case 429: {
      const retryAfterMs = parseRetryAfter(headers?.get('retry-after') ?? null);
      return new QuotaExceededError(message, retryAfterMs === undefined ? options : { ...options, retryAfterMs });
    }
    default:
      if (status >= 500) return new ServerError(message, options);
      return new AuthentaError(message, options);
  }
}
