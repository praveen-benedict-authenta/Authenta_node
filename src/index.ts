export {
  AuthentaClient,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  type AuthentaClientOptions,
  type ExtractFaceVectorOptions,
} from './client';
export {
  DEFAULT_SLOT_NAME,
  REFERENCE_SLOT_NAME,
  type AnalyzeInput,
  type AnalyzeOptions,
  type AnalyzeResult,
  type ProcessOptions,
  type SubmitOptions,
  type SubmitResult,
} from './analyze';
export { CONTENT_TYPES_BY_EXTENSION, contentTypeForAccepted, guessContentType } from './mime';
export {
  DEFAULT_MODELS,
  MODEL_SPECS,
  PAGE_COUNT_MODELS,
  getModelSpec,
  resolveModel,
  type DefaultModelCode,
  type ModelCode,
  type ModelSpec,
} from './models';
export type { ArtifactsResource } from './artifacts';
export {
  ArtifactDownloadError,
  AuthentaError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  InsufficientCreditsError,
  InvalidResponseError,
  JobCreationUncertainError,
  JobSubmissionError,
  JobTimeoutError,
  NetworkError,
  NotFoundError,
  QuotaExceededError,
  RequestTimeoutError,
  ServerError,
  UploadError,
  UploadUrlExpiredError,
  ValidationError,
  type AuthentaErrorOptions,
  type CleanupResult,
  type FieldError,
} from './errors';
export { DEFAULT_POLL_INTERVAL_MS, DEFAULT_WAIT_TIMEOUT_MS, isFinalizedStatus, isTerminalStatus, type JobsResource, type WaitOptions } from './jobs';
export type { UploadOptions, UploadResult, UploadSource, UploadsResource } from './upload';
export { FINALIZED_JOB_STATUSES, TERMINAL_JOB_STATUSES } from './types';
export type {
  AnyJobStatus,
  Artifact,
  ArtifactKind,
  ArtifactStatus,
  CallOptions,
  CreateJobRequest,
  CreateJobResponse,
  FaceIntelligenceParameters,
  FetchLike,
  InputUploadSpec,
  Job,
  JobDetail,
  JobList,
  JobStatus,
  ListJobsParams,
  TerminalJobStatus,
  UploadTarget,
} from './types';
export { SDK_VERSION } from './version';
