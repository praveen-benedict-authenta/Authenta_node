/**
 * Uploads to presigned URLs returned by job creation.
 *
 * The URL's signature covers the `Content-Type` and the byte length declared when the job was created,
 * so both are sent exactly. The Authenta API key is never sent: the URL carries its own authorization.
 */

import { createReadStream, promises as fsp } from 'node:fs';
import { basename } from 'node:path';
import { Readable } from 'node:stream';

import { AuthentaError, UploadError, UploadUrlExpiredError, ValidationError } from './errors';
import { abortReason, throwIfAborted, withTimeout } from './signals';
import type { FetchLike, UploadTarget } from './types';

/** A file path, raw bytes (`Buffer`, `Uint8Array`, `ArrayBuffer`) or a `Blob`. */
export type UploadSource = string | Uint8Array | ArrayBuffer | Blob;

export interface ResolvedSource {
  size: number;
  /** File name derived from a path source. */
  fileName?: string;
  /** Creates a fresh request body. File paths are streamed from disk. */
  createBody: () => unknown;
}

export interface UploadOptions {
  /** MIME type declared for this slot at job creation. Sent unchanged as `Content-Type`. */
  contentType: string;
  /** Byte length declared at job creation. When given, the source must match it exactly. */
  sizeBytes?: number;
  /** Slot name, used in error messages. */
  slotName?: string;
  signal?: AbortSignal;
  /** Overrides the client's upload timeout. */
  timeoutMs?: number;
}

export interface UploadResult {
  /** HTTP status returned by the storage service (200 or 204). */
  status: number;
  sizeBytes: number;
}

const EXPIRED_PATTERNS = [/Request has expired/i, /<Code>ExpiredToken<\/Code>/i, /UPLOAD_EXPIRED/];
const MAX_ERROR_BODY_LENGTH = 500;

/** Reads the size of a source without loading file contents into memory. */
export async function resolveSource(source: UploadSource): Promise<ResolvedSource> {
  if (typeof source === 'string') {
    const stat = await fsp.stat(source).catch((error: unknown) => {
      throw new ValidationError(`Cannot read upload source file: ${error instanceof Error ? error.message : String(error)}`, {
        code: 'INVALID_SOURCE',
        cause: error,
      });
    });
    if (!stat.isFile()) throw new ValidationError('Upload source path is not a regular file', { code: 'INVALID_SOURCE' });
    return { size: stat.size, fileName: basename(source), createBody: () => createReadStream(source) };
  }
  if (source instanceof Uint8Array) return { size: source.byteLength, createBody: () => source };
  if (source instanceof ArrayBuffer) return { size: source.byteLength, createBody: () => new Uint8Array(source) };
  if (typeof Blob !== 'undefined' && source instanceof Blob) return { size: source.size, createBody: () => source };
  throw new ValidationError('Upload source must be a file path, Buffer, Uint8Array, ArrayBuffer or Blob', { code: 'INVALID_SOURCE' });
}

function storageErrorCode(body: string): string | undefined {
  const xml = /<Code>([^<]+)<\/Code>/.exec(body);
  if (xml?.[1]) return xml[1];
  try {
    const parsed = JSON.parse(body) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

export class UploadsResource {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly defaultTimeoutMs: number,
  ) {}

  /** PUTs one source to one presigned upload target. */
  async put(target: Pick<UploadTarget, 'uploadUrl'> & Partial<UploadTarget>, source: UploadSource, options: UploadOptions): Promise<UploadResult> {
    const slotName = options.slotName ?? target.slotName;
    const slotOptions = slotName === undefined ? {} : { slotName };
    if (typeof target.uploadUrl !== 'string' || !target.uploadUrl) {
      throw new ValidationError('uploadUrl is required', { code: 'INVALID_ARGUMENT' });
    }
    if (typeof options.contentType !== 'string' || !options.contentType.trim()) {
      throw new ValidationError('contentType is required for uploads', { code: 'INVALID_ARGUMENT' });
    }

    throwIfAborted(options.signal);
    const resolved = await resolveSource(source);
    if (options.sizeBytes !== undefined && options.sizeBytes !== resolved.size) {
      throw new ValidationError(`Upload source is ${resolved.size} bytes but ${options.sizeBytes} bytes were declared`, {
        code: 'SIZE_MISMATCH',
      });
    }

    if (target.uploadUrlExpiresAt !== undefined) {
      const expiresAt = Date.parse(target.uploadUrlExpiresAt);
      if (!Number.isNaN(expiresAt) && Date.now() >= expiresAt) {
        throw new UploadUrlExpiredError(`Upload URL${slotName ? ` for slot "${slotName}"` : ''} expired at ${target.uploadUrlExpiresAt}`, {
          code: 'UPLOAD_URL_EXPIRED',
          ...slotOptions,
        });
      }
    }

    const timed = withTimeout(options.timeoutMs ?? this.defaultTimeoutMs, options.signal);
    const body = resolved.createBody();
    let status: number;
    let text: string;
    try {
      const init = {
        method: 'PUT',
        headers: { 'Content-Type': options.contentType, 'Content-Length': String(resolved.size) },
        body,
        signal: timed.signal,
        duplex: 'half',
      };
      const response = await this.fetchImpl(target.uploadUrl, init as unknown as RequestInit);
      status = response.status;
      text = await response.text();
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (error instanceof AuthentaError) throw error;
      const timedOut = timed.timedOut();
      throw new UploadError(timedOut ? 'Upload timed out' : `Upload failed: ${error instanceof Error ? error.message : String(error)}`, {
        code: timedOut ? 'UPLOAD_TIMEOUT' : 'UPLOAD_NETWORK_ERROR',
        cause: error,
        ...slotOptions,
      });
    } finally {
      timed.dispose();
      // Close the file if the request ended before reading all of it (error, timeout or abort).
      if (body instanceof Readable && !body.destroyed) body.destroy();
    }

    if (status >= 200 && status < 300) return { status, sizeBytes: resolved.size };

    const snippet = text.length > MAX_ERROR_BODY_LENGTH ? `${text.slice(0, MAX_ERROR_BODY_LENGTH)}…` : text;
    const code = storageErrorCode(text);
    const expired = status === 410 || (status === 403 && EXPIRED_PATTERNS.some(pattern => pattern.test(text)));
    const ErrorClass = expired ? UploadUrlExpiredError : UploadError;
    throw new ErrorClass(`Upload rejected by storage with HTTP ${status}${code ? ` (${code})` : ''}`, {
      status,
      body: snippet,
      code: expired ? 'UPLOAD_URL_EXPIRED' : (code ?? 'UPLOAD_REJECTED'),
      ...slotOptions,
    });
  }
}
