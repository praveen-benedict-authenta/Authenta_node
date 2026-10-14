/**
 * Low-level access to the `/api/v1/jobs` endpoints.
 */

import {
  ConflictError,
  JobCreationUncertainError,
  JobTimeoutError,
  NetworkError,
  RequestTimeoutError,
  ServerError,
  ValidationError,
} from './errors';
import type { HttpClient } from './http';
import { normalizeId } from './ids';
import { abortReason, sleep, throwIfAborted } from './signals';
import {
  FINALIZED_JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  type AnyJobStatus,
  type CallOptions,
  type CreateJobRequest,
  type CreateJobResponse,
  type Job,
  type JobDetail,
  type JobList,
  type ListJobsParams,
  type TerminalJobStatus,
} from './types';
import { asCreateJobResponse, asJob, asJobDetail, asJobList } from './validate';

export interface WaitOptions {
  /** Delay between polls. Default 5000 ms. */
  intervalMs?: number;
  /** Maximum total wait. Default 600000 ms (10 minutes). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called after each poll whose status differs from the previous poll (including the first). */
  onStatusChange?: (job: JobDetail, previousStatus: AnyJobStatus | undefined) => void;
}

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
const MAX_INPUTS = 3;

/** True for `completed`, `failed` and `cancelled`. */
export function isTerminalStatus(status: AnyJobStatus): status is TerminalJobStatus {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

/** True for statuses a job can only reach after a successful finalize. */
export function isFinalizedStatus(status: AnyJobStatus): boolean {
  return (FINALIZED_JOB_STATUSES as readonly string[]).includes(status);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function toIsoDate(value: string | Date | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${label} must be a valid date`, { code: 'INVALID_ARGUMENT' });
  return date.toISOString();
}

function validateCreateRequest(request: CreateJobRequest): void {
  const { inputs } = request;
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_INPUTS) {
    throw new ValidationError(`inputs must contain between 1 and ${MAX_INPUTS} entries`, { code: 'INVALID_ARGUMENT' });
  }
  const seen = new Set<string>();
  inputs.forEach((input, index) => {
    const where = `inputs[${index}]`;
    for (const key of ['slotName', 'fileName', 'contentType'] as const) {
      if (typeof input[key] !== 'string' || !input[key].trim()) {
        throw new ValidationError(`${where}.${key} must be a non-empty string`, { code: 'INVALID_ARGUMENT' });
      }
    }
    if (!isPositiveInteger(input.sizeBytes)) {
      throw new ValidationError(`${where}.sizeBytes must be a positive integer`, { code: 'INVALID_ARGUMENT' });
    }
    if (input.pageCount !== undefined && !isPositiveInteger(input.pageCount)) {
      throw new ValidationError(`${where}.pageCount must be a positive integer`, { code: 'INVALID_ARGUMENT' });
    }
    if (seen.has(input.slotName)) throw new ValidationError(`Duplicate slotName "${input.slotName}"`, { code: 'INVALID_ARGUMENT' });
    seen.add(input.slotName);
  });
}

export class JobsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Creates a job and returns one presigned upload target per input slot.
   *
   * The wallet is charged when the job is created. This call is never retried: if the outcome is
   * unknown (network failure, timeout, abort after sending, or a 5xx) it throws
   * `JobCreationUncertainError`.
   */
  async create(request: CreateJobRequest, options: CallOptions = {}): Promise<CreateJobResponse> {
    const taskTypeId = normalizeId(request.taskTypeId, 'taskTypeId');
    validateCreateRequest(request);
    throwIfAborted(options.signal);

    const body: Record<string, unknown> = {
      taskTypeId,
      inputs: request.inputs.map(input => ({
        slotName: input.slotName,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        ...(input.pageCount === undefined ? {} : { pageCount: input.pageCount }),
      })),
    };
    if (request.parameters !== undefined) body.parameters = request.parameters;

    let response: unknown;
    try {
      response = await this.http.request({ method: 'POST', path: '/jobs', body, signal: options.signal, timeoutMs: options.timeoutMs });
    } catch (error) {
      const uncertain =
        (error instanceof NetworkError && error.possiblySent) ||
        error instanceof RequestTimeoutError ||
        error instanceof ServerError ||
        options.signal?.aborted === true;
      if (!uncertain) throw error;
      throw new JobCreationUncertainError(
        'Job creation outcome is unknown: the job may have been created and charged. ' +
          'Check jobs.list({ createdAfter }) before creating it again.',
        { cause: options.signal?.aborted ? abortReason(options.signal) : error, code: 'JOB_CREATION_UNCERTAIN' },
      );
    }
    return asCreateJobResponse(response);
  }

  /** Returns the job, its raw `result` and its artifacts (with signed download URLs). */
  async get(jobId: string | number | bigint, options: CallOptions = {}): Promise<JobDetail> {
    const id = normalizeId(jobId, 'jobId');
    const body = await this.http.request({ method: 'GET', path: `/jobs/${id}`, signal: options.signal, timeoutMs: options.timeoutMs });
    return asJobDetail(body);
  }

  /** Lists the tenant's jobs, newest first, using the server's limit/offset pagination. */
  async list(params: ListJobsParams = {}, options: CallOptions = {}): Promise<JobList> {
    if (params.limit !== undefined && (!isPositiveInteger(params.limit) || params.limit > 100)) {
      throw new ValidationError('limit must be an integer between 1 and 100', { code: 'INVALID_ARGUMENT' });
    }
    if (params.offset !== undefined && (!Number.isSafeInteger(params.offset) || params.offset < 0)) {
      throw new ValidationError('offset must be a non-negative integer', { code: 'INVALID_ARGUMENT' });
    }
    const body = await this.http.request({
      method: 'GET',
      path: '/jobs',
      query: {
        limit: params.limit,
        offset: params.offset,
        status: params.status,
        taskTypeSlug: params.taskTypeSlug,
        createdAfter: toIsoDate(params.createdAfter, 'createdAfter'),
        createdBefore: toIsoDate(params.createdBefore, 'createdBefore'),
      },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return asJobList(body);
  }

  /**
   * Iterates over every matching job, fetching pages of `limit` (default 100) on demand. Pagination
   * is offset-based and newest-first, so jobs created during iteration can cause duplicates.
   */
  async *iterate(params: Omit<ListJobsParams, 'offset'> = {}, options: CallOptions = {}): AsyncGenerator<Job, void, undefined> {
    const limit = params.limit ?? 100;
    let offset = 0;
    for (;;) {
      const page = await this.list({ ...params, limit, offset }, options);
      for (const job of page.data) yield job;
      offset += page.data.length;
      if (page.data.length === 0 || offset >= page.total) return;
    }
  }

  /**
   * Marks all uploads as complete and queues the job. A `409` is reconciled with the job's current
   * state: if the job has demonstrably been finalized already, that job is returned; otherwise the
   * `ConflictError` is rethrown.
   */
  async finalize(jobId: string | number | bigint, options: CallOptions = {}): Promise<Job> {
    const id = normalizeId(jobId, 'jobId');
    try {
      const body = await this.http.request({ method: 'POST', path: `/jobs/${id}/finalize`, signal: options.signal, timeoutMs: options.timeoutMs });
      return asJob(body);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const current = await this.get(id, options);
      if (isFinalizedStatus(current.status)) return current;
      throw new ConflictError(`Job ${id} cannot be finalized: its status is "${current.status}"`, {
        status: error.status,
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
        body: error.body,
        jobId: id,
        cause: error,
      });
    }
  }

  /** Cancels a job that is still `initiated` or `queued`. Other statuses fail with `ValidationError` (422). */
  async cancel(jobId: string | number | bigint, options: CallOptions = {}): Promise<Job> {
    const id = normalizeId(jobId, 'jobId');
    const body = await this.http.request({ method: 'POST', path: `/jobs/${id}/cancel`, signal: options.signal, timeoutMs: options.timeoutMs });
    return asJob(body);
  }

  /**
   * Soft-deletes a job and its stored files. A job that is `initiated` or `queued` is cancelled first by
   * the server; a `processing` job cannot be deleted (422).
   */
  async delete(jobId: string | number | bigint, options: CallOptions = {}): Promise<void> {
    const id = normalizeId(jobId, 'jobId');
    await this.http.request({ method: 'DELETE', path: `/jobs/${id}`, signal: options.signal, timeoutMs: options.timeoutMs });
  }

  /**
   * Polls until the job is `completed`, `failed` or `cancelled` and returns it. A failed or cancelled
   * job is returned, not thrown: check `job.status`. Throws `JobTimeoutError` when `timeoutMs` passes.
   */
  async waitForCompletion(jobId: string | number | bigint, options: WaitOptions = {}): Promise<JobDetail> {
    const id = normalizeId(jobId, 'jobId');
    const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new ValidationError('intervalMs must be >= 0', { code: 'INVALID_ARGUMENT' });
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ValidationError('timeoutMs must be > 0', { code: 'INVALID_ARGUMENT' });

    const deadline = Date.now() + timeoutMs;
    let previous: AnyJobStatus | undefined;
    for (;;) {
      const job = await this.get(id, { signal: options.signal });
      if (job.status !== previous) {
        options.onStatusChange?.(job, previous);
        previous = job.status;
      }
      if (isTerminalStatus(job.status)) return job;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new JobTimeoutError(`Job ${id} did not finish within ${timeoutMs} ms (last status "${job.status}")`, job, {
          code: 'JOB_WAIT_TIMEOUT',
        });
      }
      await sleep(Math.min(intervalMs, remaining), options.signal);
    }
  }
}
