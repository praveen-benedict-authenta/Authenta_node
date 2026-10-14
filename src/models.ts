/**
 * Authenta model codes (`AC-1`, `DF-1`, …) and the task type, input slots and accepted content types
 * each one maps to.
 *
 * If your deployment uses a different configuration, override the IDs:
 * `new AuthentaClient({ apiKey, models: { 'PDF-1': '<id>' } })`.
 */

import { ValidationError } from './errors';

export interface ModelSpec {
  /** Task type ID. */
  readonly taskTypeId: string;
  /** Task type slug. */
  readonly slug: string;
  readonly name: string;
  /** Accepted content types per input slot. */
  readonly slots: Readonly<Record<string, readonly string[]>>;
}

const IMAGE = ['image/jpeg', 'image/png'] as const;
const AUDIO = ['audio/mpeg', 'audio/wav', 'audio/m4a'] as const;

export const MODEL_SPECS = {
  'AC-1': { taskTypeId: '1', slug: 'ai-image-detection', name: 'AI image detection', slots: { original: IMAGE } },
  'AF-1': { taskTypeId: '2', slug: 'ai-audio-detection', name: 'AI audio detection', slots: { original: AUDIO } },
  'VF-1': { taskTypeId: '3', slug: 'ai-video-detection', name: 'AI video detection', slots: { original: ['video/mp4', 'video/mov'] } },
  'DF-1': {
    taskTypeId: '4',
    slug: 'faceswap-detection',
    name: 'Face swap detection',
    slots: { original: ['video/mp4', 'video/mov', 'video/webm'] },
  },
  'FD-1': { taskTypeId: '5', slug: 'image-forgery-detection', name: 'Image forgery detection', slots: { original: IMAGE } },
  'DI-1': { taskTypeId: '6', slug: 'document-intelligence', name: 'Document forgery detection', slots: { original: IMAGE } },
  'FL-1': { taskTypeId: '7', slug: 'face-liveness-detection', name: 'Face liveness detection', slots: { original: IMAGE } },
  'FI-1': {
    taskTypeId: '8',
    slug: 'face-intelligence',
    name: 'Face intelligence',
    slots: { original: ['image/jpeg', 'image/png', 'video/mp4', 'video/webm', 'video/quicktime'], reference: IMAGE },
  },
  'FE-1': { taskTypeId: '9', slug: 'face-embedding', name: 'Face embedding', slots: { original: IMAGE } },
  'AS-1': { taskTypeId: '10', slug: 'audio-splitter', name: 'Audio splitter', slots: { original: AUDIO } },
  'ED-1': {
    taskTypeId: '11',
    slug: 'ekyc-deepfake',
    name: 'eKYC deepfake detection',
    slots: { original: ['video/mp4', 'video/mov', 'video/webm'] },
  },
  'PDF-1': {
    taskTypeId: '12',
    slug: 'pdf-tampering-detection',
    name: 'PDF tampering detection',
    slots: { original: ['application/pdf'] },
  },
} as const satisfies Record<string, ModelSpec>;

export type DefaultModelCode = keyof typeof MODEL_SPECS;

/** A built-in model code, or a custom one added through the client's `models` option. */
export type ModelCode = DefaultModelCode | (string & {});

/** Model code → task type ID. */
export const DEFAULT_MODELS = Object.fromEntries(
  Object.entries(MODEL_SPECS).map(([code, spec]) => [code, spec.taskTypeId]),
) as { readonly [K in DefaultModelCode]: (typeof MODEL_SPECS)[K]['taskTypeId'] };

/** Slug of the page-priced task type: jobs for it must include `pageCount`. */
export const PAGE_PRICED_SLUG = 'pdf-tampering-detection';

/** Model codes whose jobs are priced per page and must include `pageCount`. */
export const PAGE_COUNT_MODELS: readonly string[] = Object.entries(MODEL_SPECS)
  .filter(([, spec]) => spec.slug === PAGE_PRICED_SLUG)
  .map(([code]) => code);

/** Upper-cases and trims a model code for comparisons. */
export function normalizeModelCode(model: string): string {
  return model.trim().toUpperCase();
}

/** The built-in spec for a model code, or `undefined` for custom codes. */
export function getModelSpec(model: string): ModelSpec | undefined {
  const code = normalizeModelCode(model);
  return Object.hasOwn(MODEL_SPECS, code) ? (MODEL_SPECS as Record<string, ModelSpec>)[code] : undefined;
}

/** Builds the effective model table: defaults plus overrides, keyed by upper-cased code. */
export function buildModelTable(overrides: Record<string, string | number> = {}): Record<string, string> {
  const table: Record<string, string> = { ...DEFAULT_MODELS };
  for (const [code, id] of Object.entries(overrides)) table[normalizeModelCode(code)] = String(id);
  return table;
}

/** Converts a model code to its task type ID, or throws `ValidationError` listing the valid codes. */
export function resolveModel(model: ModelCode, table: Record<string, string> = buildModelTable()): string {
  const key = typeof model === 'string' ? normalizeModelCode(model) : '';
  const id = Object.hasOwn(table, key) ? table[key] : undefined;
  if (id === undefined) {
    throw new ValidationError(`Unknown model "${String(model)}". Valid models: ${Object.keys(table).join(', ')}`, {
      code: 'UNKNOWN_MODEL',
    });
  }
  return id;
}
