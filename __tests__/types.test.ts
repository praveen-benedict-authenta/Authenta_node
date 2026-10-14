/**
 * Compile-time checks. ts-jest type-checks this file, so a broken public type fails the suite.
 */

import {
  AuthentaClient,
  isTerminalStatus,
  TERMINAL_JOB_STATUSES,
  type AnalyzeResult,
  type CreateJobRequest,
  type Job,
  type JobDetail,
  type JobStatus,
  type ListJobsParams,
} from '../src';
import * as sdk from '../src';

describe('public types', () => {
  it('exposes the terminal statuses', () => {
    expect(TERMINAL_JOB_STATUSES).toEqual(['completed', 'failed', 'cancelled']);
    const statuses: JobStatus[] = ['initiated', 'queued', 'processing', 'completed', 'failed', 'cancelled', 'deleted'];
    expect(statuses.filter(isTerminalStatus)).toEqual(['completed', 'failed', 'cancelled']);
  });

  it('accepts string, number and bigint task type IDs', () => {
    const requests: CreateJobRequest[] = [
      { taskTypeId: '1', inputs: [] },
      { taskTypeId: 1, inputs: [] },
      { taskTypeId: 1n, inputs: [] },
    ];
    expect(requests).toHaveLength(3);
  });

  it('rejects invalid shapes at compile time', () => {
    // @ts-expect-error status filter cannot be "deleted"
    const params: ListJobsParams = { status: 'deleted' };
    // @ts-expect-error the backend has no page parameter
    const paged: ListJobsParams = { page: 2 };
    // @ts-expect-error apiKey is required
    const build = () => new AuthentaClient({});
    expect([params, paged, build]).toHaveLength(3);
  });

  it('types results as unknown so callers must narrow them', () => {
    const job: Job = { id: '1', tenantId: 't', taskTypeId: '1', status: 'completed', cost: 1, createdAt: '', updatedAt: '', result: { isFake: true } };
    // @ts-expect-error result is unknown and must be narrowed before use
    const fake: boolean = job.result.isFake;
    expect(fake).toBe(true);
  });

  it('returns job details from analyze', () => {
    type Check = AnalyzeResult['job'] extends JobDetail ? true : false;
    const ok: Check = true;
    expect(ok).toBe(true);
  });

  it('ships the default model table', () => {
    expect(sdk.DEFAULT_MODELS).toEqual({
      'AC-1': '1',
      'AF-1': '2',
      'VF-1': '3',
      'DF-1': '4',
      'FD-1': '5',
      'DI-1': '6',
      'FL-1': '7',
      'FI-1': '8',
      'FE-1': '9',
      'AS-1': '10',
      'ED-1': '11',
      'PDF-1': '12',
    });
  });
});
