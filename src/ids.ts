/**
 * Validation for numeric job and task type IDs, checked locally before any request is sent.
 */

import { ValidationError } from './errors';

const MAX_BIGINT = 9223372036854775807n;

/** Normalizes a job or task type ID to a digit string, or throws `ValidationError`. */
export function normalizeId(value: unknown, label: string): string {
  let text: string;
  if (typeof value === 'string') text = value.trim();
  else if (typeof value === 'number' && Number.isSafeInteger(value)) text = String(value);
  else if (typeof value === 'bigint') text = value.toString();
  else throw new ValidationError(`${label} must be a digit string, safe integer or bigint`, { code: 'INVALID_ID' });

  const numeric = /^\d{1,19}$/.test(text) ? BigInt(text) : 0n;
  if (numeric < 1n || numeric > MAX_BIGINT) {
    throw new ValidationError(`${label} must be a positive integer ID, received "${text}"`, { code: 'INVALID_ID' });
  }
  return numeric.toString();
}
