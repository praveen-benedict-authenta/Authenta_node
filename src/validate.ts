/**
 * Minimal runtime checks on API responses. They confirm the fields this SDK relies on, so a changed or
 * malformed response fails loudly instead of producing `undefined` further down the line.
 */

import { InvalidResponseError } from './errors';
import type { CreateJobResponse, Job, JobDetail, JobList } from './types';

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(what: string, body: unknown): never {
  throw new InvalidResponseError(`Unexpected API response: ${what}`, { body, code: 'INVALID_RESPONSE' });
}

function checkJob(value: unknown, body: unknown, where: string): asserts value is Job {
  if (!isObject(value)) fail(`${where} is not an object`, body);
  if (typeof value.id !== 'string' || !/^\d+$/.test(value.id)) fail(`${where}.id is not a numeric string`, body);
  if (typeof value.status !== 'string') fail(`${where}.status is not a string`, body);
}

export function asJob(body: unknown): Job {
  checkJob(body, body, 'job');
  return body;
}

export function asJobDetail(body: unknown): JobDetail {
  checkJob(body, body, 'job');
  if (!Array.isArray((body as unknown as Obj).artifacts)) fail('job.artifacts is not an array', body);
  return body as JobDetail;
}

export function asCreateJobResponse(body: unknown): CreateJobResponse {
  if (!isObject(body)) fail('create response is not an object', body);
  checkJob(body.job, body, 'job');
  if (!Array.isArray(body.inputs)) fail('inputs is not an array', body);
  for (const input of body.inputs) {
    if (!isObject(input) || typeof input.slotName !== 'string' || typeof input.uploadUrl !== 'string') {
      fail('inputs[] entry is missing slotName or uploadUrl', body);
    }
  }
  return body as unknown as CreateJobResponse;
}

export function asJobList(body: unknown): JobList {
  if (!isObject(body)) fail('list response is not an object', body);
  if (!Array.isArray(body.data)) fail('list.data is not an array', body);
  for (const key of ['limit', 'offset', 'total'] as const) {
    if (typeof body[key] !== 'number') fail(`list.${key} is not a number`, body);
  }
  body.data.forEach((job, index) => checkJob(job, body, `data[${index}]`));
  return body as unknown as JobList;
}
