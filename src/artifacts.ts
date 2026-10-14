/**
 * Access to job artifacts. Download URLs are signed and short-lived; when one has expired, fetch the
 * job again to get a fresh URL. The Authenta API key is never sent to the storage service.
 */

import { ArtifactDownloadError, AuthentaError, InvalidResponseError, ValidationError } from './errors';
import { abortReason, throwIfAborted, withTimeout } from './signals';
import type { Artifact, ArtifactKind, CallOptions, FetchLike, JobDetail } from './types';

export class ArtifactsResource {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly defaultTimeoutMs: number,
  ) {}

  /** Returns the job's artifacts, optionally filtered by kind (for example `result` or `heatmap`). */
  list(job: Pick<JobDetail, 'artifacts'>, kind?: ArtifactKind | (string & {})): Artifact[] {
    return kind === undefined ? [...job.artifacts] : job.artifacts.filter(artifact => artifact.kind === kind);
  }

  /** Downloads an artifact's bytes. */
  async download(artifact: Pick<Artifact, 'id' | 'downloadUrl'>, options: CallOptions = {}): Promise<Uint8Array> {
    if (!artifact.downloadUrl) {
      throw new ValidationError(`Artifact ${artifact.id} has no download URL yet`, { code: 'ARTIFACT_NOT_READY' });
    }
    throwIfAborted(options.signal);
    const timed = withTimeout(options.timeoutMs ?? this.defaultTimeoutMs, options.signal);
    try {
      const response = await this.fetchImpl(artifact.downloadUrl, { method: 'GET', signal: timed.signal });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new ArtifactDownloadError(`Downloading artifact ${artifact.id} failed with HTTP ${response.status}`, {
          status: response.status,
          body: text.slice(0, 500),
          code: response.status === 403 || response.status === 410 ? 'ARTIFACT_URL_EXPIRED' : 'ARTIFACT_DOWNLOAD_FAILED',
        });
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (error instanceof AuthentaError) throw error;
      throw new ArtifactDownloadError(`Downloading artifact ${artifact.id} failed`, {
        code: timed.timedOut() ? 'ARTIFACT_DOWNLOAD_TIMEOUT' : 'ARTIFACT_DOWNLOAD_FAILED',
        cause: error,
      });
    } finally {
      timed.dispose();
    }
  }

  /** Downloads an artifact and parses it as JSON, returned unvalidated. */
  async downloadJson(artifact: Pick<Artifact, 'id' | 'downloadUrl'>, options: CallOptions = {}): Promise<unknown> {
    const bytes = await this.download(artifact, options);
    const text = new TextDecoder().decode(bytes);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new InvalidResponseError(`Artifact ${artifact.id} is not valid JSON`, { body: text.slice(0, 500), cause: error, code: 'INVALID_RESPONSE' });
    }
  }
}
