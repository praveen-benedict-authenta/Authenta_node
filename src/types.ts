/**
 * Types for the Authenta Jobs API.
 *
 * These mirror the response DTOs of the Authenta API server (job.dto.ts at commit 45d73d4), not the
 * published documentation, which describes a different envelope in several places.
 */

/** Every status the backend can store. `deleted` jobs are never returned by the API (they 404). */
export type JobStatus = 'initiated' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'deleted';

/** Statuses after which a job never changes again, short of deletion. */
export type TerminalJobStatus = 'completed' | 'failed' | 'cancelled';

export const TERMINAL_JOB_STATUSES: readonly TerminalJobStatus[] = ['completed', 'failed', 'cancelled'];

/** Statuses that a job can only reach after it was successfully finalized. */
export const FINALIZED_JOB_STATUSES: readonly JobStatus[] = ['queued', 'processing', 'completed', 'failed'];

/** Kept open-ended so a status added on the server does not break type narrowing at runtime. */
export type AnyJobStatus = JobStatus | (string & {});

export type ArtifactKind = 'input' | 'result' | 'heatmap' | 'image' | 'report' | 'mask' | 'audio';

export type ArtifactStatus = 'pending' | 'completed';

/** A job as returned by create (inside `job`), finalize, cancel and list. */
export interface Job {
  /** Numeric job ID, serialized as a string. */
  id: string;
  tenantId: string;
  /** Numeric task type ID, serialized as a string. */
  taskTypeId: string;
  status: AnyJobStatus;
  /** Credits charged when the job was created. */
  cost: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Raw result written by the processing worker, or `null`. The shape depends on the task type and is
   * not validated by this SDK. It is not populated for failed jobs.
   */
  result?: unknown;
}

export interface Artifact {
  id: string;
  kind: ArtifactKind | (string & {});
  slotName: string | null;
  status: ArtifactStatus | (string & {});
  contentType: string;
  metadata: Record<string, unknown> | null;
  /** Short-lived signed download URL; `null` while the artifact is pending. */
  downloadUrl: string | null;
  createdAt: string;
}

/** A job as returned by `GET /jobs/:id`, including input and output artifacts. */
export interface JobDetail extends Job {
  artifacts: Artifact[];
}

/** Metadata for one input slot, declared when the job is created. */
export interface InputUploadSpec {
  /** Slot name defined by the task type (for example `original`). */
  slotName: string;
  /** Original file name; stored as metadata only. */
  fileName: string;
  /** MIME type. Must exactly match one accepted by the slot, and is signed into the upload URL. */
  contentType: string;
  /** Exact byte length of the file. Signed into the upload URL. */
  sizeBytes: number;
  /** Page count, required by page-priced task types such as PDF tampering detection. */
  pageCount?: number;
}

/** Optional parameters. The server only accepts these keys, and only uses them for face intelligence. */
export interface FaceIntelligenceParameters {
  isFaceswapCheck?: boolean;
  isLivenessCheck?: boolean;
  isSimilarityCheck?: boolean;
}

export interface CreateJobRequest {
  /** Task type ID for your deployment. This SDK does not ship a list of IDs. */
  taskTypeId: string | number | bigint;
  /** Between one and three inputs, one per slot defined by the task type. */
  inputs: InputUploadSpec[];
  parameters?: FaceIntelligenceParameters;
}

/** One presigned upload target per input slot. */
export interface UploadTarget {
  slotName: string;
  uploadUrl: string;
  /** ISO 8601 timestamp after which the upload URL is rejected. */
  uploadUrlExpiresAt: string;
}

export interface CreateJobResponse {
  job: Job;
  inputs: UploadTarget[];
}

export interface ListJobsParams {
  /** Page size, 1–100. Server default is 20. */
  limit?: number;
  /** Number of jobs to skip. Server default is 0. */
  offset?: number;
  status?: Exclude<JobStatus, 'deleted'>;
  /** Filter by task type slug. */
  taskTypeSlug?: string;
  createdAfter?: string | Date;
  createdBefore?: string | Date;
}

export interface JobList {
  limit: number;
  offset: number;
  total: number;
  data: Job[];
}

/** Common per-call options. */
export interface CallOptions {
  /** Abort the call. The promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Override the client's request timeout for this call. */
  timeoutMs?: number;
}

/** Minimal `fetch` signature so any compatible implementation can be injected. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
