/**
 * Content types from file extensions.
 *
 * For a known model code, the content type is chosen from the types that model's slot accepts (for
 * example `.mov` becomes `video/mov` for DF-1 but `video/quicktime` for FI-1). Without a model, a
 * standard type is used.
 */

import { ValidationError } from './errors';

/** Every content type an extension may stand for, most standard first. */
const CANDIDATES_BY_EXTENSION: Readonly<Record<string, readonly string[]>> = {
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.webp': ['image/webp'],
  '.mp3': ['audio/mpeg'],
  '.wav': ['audio/wav'],
  '.m4a': ['audio/mp4', 'audio/m4a', 'audio/x-m4a'],
  '.mp4': ['video/mp4'],
  '.mov': ['video/quicktime', 'video/mov'],
  '.webm': ['video/webm'],
  '.pdf': ['application/pdf'],
};

/** Standard content type per extension, used when no model is known. */
export const CONTENT_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CANDIDATES_BY_EXTENSION).map(([extension, types]) => [extension, types[0] as string]),
);

function extensionOf(fileName: string): string | undefined {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? undefined : base.slice(dot).toLowerCase();
}

/** Standard content type for a file name or path, or `undefined` for unknown extensions. */
export function guessContentType(fileName: string): string | undefined {
  const extension = extensionOf(fileName);
  return extension === undefined ? undefined : CONTENT_TYPES_BY_EXTENSION[extension];
}

/** The content type, among those `accepted`, that a file name's extension stands for. */
export function contentTypeForAccepted(fileName: string, accepted: readonly string[]): string | undefined {
  const extension = extensionOf(fileName);
  const candidates = extension === undefined ? undefined : CANDIDATES_BY_EXTENSION[extension];
  return candidates?.find(type => accepted.includes(type));
}

/** File extensions that map to at least one of the accepted content types, for error messages. */
export function extensionsFor(accepted: readonly string[]): string[] {
  return Object.entries(CANDIDATES_BY_EXTENSION)
    .filter(([, types]) => types.some(type => accepted.includes(type)))
    .map(([extension]) => extension.slice(1));
}

/**
 * Resolves the content type for a model's slot: picks the accepted type matching the extension, or
 * throws `ValidationError` before any request when the file type is not accepted by the model.
 */
export function resolveAcceptedContentType(fileName: string, accepted: readonly string[], label: string): string {
  const type = contentTypeForAccepted(fileName, accepted);
  if (type) return type;
  throw new ValidationError(`${label} does not accept "${fileName}". Accepted file types: ${extensionsFor(accepted).join(', ')}`, {
    code: 'CONTENT_TYPE_NOT_ACCEPTED',
  });
}

export function isImageType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('image/');
}

export function isVideoType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('video/');
}
