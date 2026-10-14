/**
 * High-level workflow: create a job, upload every input, finalize, and optionally wait for the result.
 */

import {
  InvalidResponseError,
  JobSubmissionError,
  NetworkError,
  RequestTimeoutError,
  ServerError,
  ValidationError,
  type CleanupResult,
} from './errors';
import { isFinalizedStatus, type JobsResource, type WaitOptions } from './jobs';
import { guessContentType, isImageType, isVideoType, resolveAcceptedContentType } from './mime';
import { PAGE_COUNT_MODELS, getModelSpec, normalizeModelCode, resolveModel, type ModelCode } from './models';
import { throwIfAborted } from './signals';
import type { CreateJobResponse, FaceIntelligenceParameters, Job, JobDetail } from './types';
import { resolveSource, type UploadSource, type UploadsResource } from './upload';

/** Slot used when an input does not name one. */
export const DEFAULT_SLOT_NAME = 'original';
/** Slot used for the reference image of a face similarity check. */
export const REFERENCE_SLOT_NAME = 'reference';

export interface AnalyzeInput {
  /** Slot name defined by the task type. Default `original`. */
  slotName?: string;
  source: UploadSource;
  /**
   * MIME type accepted by the slot. When omitted it is guessed from the file extension of a path
   * source or `fileName`; unknown extensions are rejected.
   */
  contentType?: string;
  /** Defaults to the file's base name for path sources; required for in-memory sources. */
  fileName?: string;
  /** Required by page-priced task types such as PDF tampering detection (`PDF-1`). */
  pageCount?: number;
}

/** Choose the model either by code (`model: 'AC-1'`) or by task type ID (`taskTypeId: '1'`), not both. */
export interface SubmitOptions {
  /** Model code (`AC-1`, `DF-1`, `FI-1`, …). */
  model?: ModelCode;
  /** Task type ID, for deployments or models without a code. */
  taskTypeId?: string | number | bigint;
  inputs: AnalyzeInput[];
  parameters?: FaceIntelligenceParameters;
  signal?: AbortSignal;
  /** Cancel the job when an upload or finalize fails. Default `true`. */
  cancelOnFailure?: boolean;
}

export interface AnalyzeOptions extends SubmitOptions {
  /** Polling settings for the wait step. The top-level `signal` also applies to waiting. */
  polling?: Omit<WaitOptions, 'signal'>;
}

export interface SubmitResult {
  /** The response from job creation, including upload targets. */
  created: CreateJobResponse;
  /** The job after finalization (normally `queued`). */
  job: Job;
}

export interface AnalyzeResult {
  created: CreateJobResponse;
  /** The job in a terminal status: `completed`, `failed` or `cancelled`. Check `job.status`. */
  job: JobDetail;
}

/** Options for `process()`, the one-call workflow. */
export interface ProcessOptions {
  /** Model code (`AC-1`, `DF-1`, `FI-1`, …). */
  model: ModelCode;
  /** Reference image for an FI-1 face similarity check. */
  reference?: UploadSource;
  /** FI-1: face swap check (video only). */
  faceswapCheck?: boolean;
  /** FI-1: liveness check. */
  livenessCheck?: boolean;
  /** FI-1: face similarity check against `reference` (image only). */
  faceSimilarityCheck?: boolean;
  /** Wait for a terminal status. Default `true`. */
  wait?: boolean;
  polling?: Omit<WaitOptions, 'signal'>;
  /** Overrides the content type guessed from the file extension. */
  contentType?: string;
  /** Content type of `reference`, when it cannot be guessed. */
  referenceContentType?: string;
  /** Required for in-memory sources. */
  fileName?: string;
  /** File name for an in-memory `reference`. */
  referenceFileName?: string;
  /** Required by `PDF-1`. */
  pageCount?: number;
  signal?: AbortSignal;
  cancelOnFailure?: boolean;
}

/**
 * Content type for one input. An explicit value is sent unchanged. For a built-in model, the slot must
 * exist and the file type must be one the model accepts; the matching accepted type is
 * used. Otherwise a standard type is guessed from the extension.
 */
function resolveInputContentType(
  modelCode: string | undefined,
  slotName: string,
  fileName: string,
  explicit: string | undefined,
  label: string,
): string {
  const spec = modelCode === undefined ? undefined : getModelSpec(modelCode);
  if (spec) {
    const accepted = spec.slots[slotName];
    if (!accepted) {
      throw new ValidationError(`Model ${modelCode} has no slot "${slotName}". Slots: ${Object.keys(spec.slots).join(', ')}`, {
        code: 'UNKNOWN_SLOT',
      });
    }
    if (explicit !== undefined) return explicit;
    return resolveAcceptedContentType(fileName, accepted, `Model ${modelCode} (slot "${slotName}")`);
  }
  if (explicit !== undefined) return explicit;
  const guessed = guessContentType(fileName);
  if (!guessed) {
    throw new ValidationError(`${label}.contentType is required: cannot guess it from "${fileName}"`, { code: 'CONTENT_TYPE_REQUIRED' });
  }
  return guessed;
}

function isAmbiguous(error: unknown): boolean {
  return (error instanceof NetworkError && error.possiblySent) || error instanceof RequestTimeoutError || error instanceof ServerError;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Workflow {
  constructor(
    private readonly jobs: JobsResource,
    private readonly uploads: UploadsResource,
    private readonly modelTable: Record<string, string>,
  ) {}

  /** Creates the job, uploads each input and finalizes. Does not wait for processing. */
  async submit(options: SubmitOptions): Promise<SubmitResult> {
    throwIfAborted(options.signal);
    const taskTypeId = this.resolveTaskTypeId(options);
    if (!Array.isArray(options.inputs) || options.inputs.length === 0) {
      throw new ValidationError('inputs must contain at least one entry', { code: 'INVALID_ARGUMENT' });
    }
    const modelCode = options.model === undefined ? undefined : normalizeModelCode(String(options.model));
    const requiresPageCount = modelCode !== undefined && PAGE_COUNT_MODELS.includes(modelCode);

    const prepared = await Promise.all(
      options.inputs.map(async (input, index) => {
        const resolved = await resolveSource(input.source);
        const fileName = input.fileName ?? resolved.fileName;
        if (!fileName) {
          throw new ValidationError(`inputs[${index}].fileName is required for in-memory sources`, { code: 'INVALID_ARGUMENT' });
        }
        const slotName = input.slotName ?? DEFAULT_SLOT_NAME;
        const contentType = resolveInputContentType(modelCode, slotName, fileName, input.contentType, `inputs[${index}]`);
        if (requiresPageCount && input.pageCount === undefined) {
          throw new ValidationError(`inputs[${index}].pageCount is required for model ${String(modelCode)}`, {
            code: 'PAGE_COUNT_REQUIRED',
          });
        }
        return { input, slotName, contentType, sizeBytes: resolved.size, fileName };
      }),
    );

    const created = await this.jobs.create(
      {
        taskTypeId,
        inputs: prepared.map(({ input, slotName, contentType, sizeBytes, fileName }) => ({
          slotName,
          fileName,
          contentType,
          sizeBytes,
          ...(input.pageCount === undefined ? {} : { pageCount: input.pageCount }),
        })),
        ...(options.parameters === undefined ? {} : { parameters: options.parameters }),
      },
      { ...(options.signal === undefined ? {} : { signal: options.signal }) },
    );
    const jobId = created.job.id;

    let stage: 'upload' | 'finalize' = 'upload';
    try {
      for (const { input, slotName, contentType, sizeBytes } of prepared) {
        const target = created.inputs.find(candidate => candidate.slotName === slotName);
        if (!target) {
          throw new InvalidResponseError(`Create response has no upload URL for slot "${slotName}"`, { body: created, jobId });
        }
        await this.uploads.put(target, input.source, {
          contentType,
          sizeBytes,
          slotName,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      }

      stage = 'finalize';
      const job = await this.finalize(jobId, options.signal);
      return { created, job };
    } catch (error) {
      const cleanup = options.cancelOnFailure === false ? { attempted: false, succeeded: false } : await this.cancelQuietly(jobId);
      throw new JobSubmissionError(this.failureMessage(jobId, stage, error, cleanup), {
        jobId,
        stage,
        cleanup,
        cause: error,
        code: 'JOB_SUBMISSION_FAILED',
      });
    }
  }

  /** `submit()` followed by `jobs.waitForCompletion()`. */
  async analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
    const { created, job } = await this.submit(options);
    const finished = await this.jobs.waitForCompletion(job.id, {
      ...options.polling,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return { created, job: finished };
  }

  /**
   * One-call workflow: builds the inputs from a model code and
   * file, applies the FI-1 rules, then submits and (by default) waits for a terminal status.
   */
  async process(source: UploadSource, options: ProcessOptions): Promise<AnalyzeResult | SubmitResult> {
    throwIfAborted(options.signal);
    if (options.model === undefined) throw new ValidationError('model is required', { code: 'INVALID_ARGUMENT' });
    const model = normalizeModelCode(String(options.model));

    const resolved = await resolveSource(source);
    const fileName = options.fileName ?? resolved.fileName;
    const contentType =
      options.contentType ?? (fileName ? resolveInputContentType(model, DEFAULT_SLOT_NAME, fileName, undefined, 'source') : undefined);

    const inputs: AnalyzeInput[] = [
      {
        slotName: DEFAULT_SLOT_NAME,
        source,
        ...(contentType === undefined ? {} : { contentType }),
        ...(options.fileName === undefined ? {} : { fileName: options.fileName }),
        ...(options.pageCount === undefined ? {} : { pageCount: options.pageCount }),
      },
    ];

    let parameters: FaceIntelligenceParameters | undefined;
    if (model === 'FI-1') {
      const { faceswapCheck = false, livenessCheck = false, faceSimilarityCheck = false } = options;
      if (contentType && isImageType(contentType) && faceswapCheck) {
        throw new ValidationError('faceswapCheck cannot be true for image media', { code: 'INVALID_ARGUMENT' });
      }
      if (contentType && isVideoType(contentType) && faceSimilarityCheck) {
        throw new ValidationError('faceSimilarityCheck cannot be true for video media', { code: 'INVALID_ARGUMENT' });
      }
      if (faceSimilarityCheck && options.reference === undefined) {
        throw new ValidationError('reference is required when faceSimilarityCheck is true', { code: 'INVALID_ARGUMENT' });
      }
      if (!faceswapCheck && !livenessCheck && !faceSimilarityCheck) {
        throw new ValidationError('FI-1 needs at least one of faceswapCheck, livenessCheck or faceSimilarityCheck', {
          code: 'INVALID_ARGUMENT',
        });
      }
      parameters = {
        ...(faceswapCheck ? { isFaceswapCheck: true } : {}),
        ...(livenessCheck ? { isLivenessCheck: true } : {}),
        ...(faceSimilarityCheck ? { isSimilarityCheck: true } : {}),
      };
      if (options.reference !== undefined) {
        inputs.push({
          slotName: REFERENCE_SLOT_NAME,
          source: options.reference,
          ...(options.referenceContentType === undefined ? {} : { contentType: options.referenceContentType }),
          ...(options.referenceFileName === undefined ? {} : { fileName: options.referenceFileName }),
        });
      }
    } else if (options.reference !== undefined || options.faceswapCheck || options.livenessCheck || options.faceSimilarityCheck) {
      throw new ValidationError('reference and face checks are only supported by model FI-1', { code: 'INVALID_ARGUMENT' });
    }

    const submitOptions: AnalyzeOptions = {
      model,
      inputs,
      ...(parameters === undefined ? {} : { parameters }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.cancelOnFailure === undefined ? {} : { cancelOnFailure: options.cancelOnFailure }),
      ...(options.polling === undefined ? {} : { polling: options.polling }),
    };
    return options.wait === false ? this.submit(submitOptions) : this.analyze(submitOptions);
  }

  private resolveTaskTypeId(options: SubmitOptions): string | number | bigint {
    if (options.model !== undefined && options.taskTypeId !== undefined) {
      throw new ValidationError('Pass either model or taskTypeId, not both', { code: 'INVALID_ARGUMENT' });
    }
    if (options.model !== undefined) return resolveModel(options.model, this.modelTable);
    if (options.taskTypeId !== undefined) return options.taskTypeId;
    throw new ValidationError('model or taskTypeId is required', { code: 'INVALID_ARGUMENT' });
  }

  /** Finalizes, reconciling an ambiguous failure (network, timeout, 5xx) against the job's state. */
  private async finalize(jobId: string, signal: AbortSignal | undefined): Promise<Job> {
    try {
      return await this.jobs.finalize(jobId, signal === undefined ? {} : { signal });
    } catch (error) {
      if (!isAmbiguous(error) || signal?.aborted) throw error;
      const current = await this.jobs.get(jobId).catch(() => undefined);
      if (current && isFinalizedStatus(current.status)) return current;
      throw error;
    }
  }

  /** Cancels without the caller's signal, which may be the reason the submission failed. */
  private async cancelQuietly(jobId: string): Promise<CleanupResult> {
    try {
      const job = await this.jobs.cancel(jobId);
      return { attempted: true, succeeded: true, job };
    } catch (error) {
      return { attempted: true, succeeded: false, error };
    }
  }

  private failureMessage(jobId: string, stage: string, error: unknown, cleanup: CleanupResult): string {
    const base = `Job ${jobId} failed during ${stage}: ${describe(error)}.`;
    if (!cleanup.attempted) return `${base} The job was not cancelled (cancelOnFailure is false).`;
    if (cleanup.succeeded) return `${base} The job was cancelled.`;
    return `${base} Cancelling the job also failed: ${describe(cleanup.error)}.`;
  }
}
