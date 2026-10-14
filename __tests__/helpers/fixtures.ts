/**
 * Response fixtures shaped like the Authenta API server's DTOs (job.dto.ts) and its own test
 * expectations (tests/workloads/jobs.spec.ts). IDs and URLs are placeholders.
 */

import type { Artifact, CreateJobResponse, Job, JobDetail, JobList } from '../../src';

export const TENANT_ID = '6c0f1a52-6c1f-4bb3-9a43-1f0d9d4c3e11';

export function job(overrides: Partial<Job> = {}): Job {
  return {
    id: '101',
    tenantId: TENANT_ID,
    taskTypeId: '1',
    status: 'initiated',
    cost: 10,
    createdAt: '2026-10-14T10:00:00.000Z',
    updatedAt: '2026-10-14T10:00:00.000Z',
    result: null,
    ...overrides,
  };
}

export function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: '501',
    kind: 'input',
    slotName: 'original',
    status: 'completed',
    contentType: 'image/jpeg',
    metadata: { fileName: 'photo.jpg', sizeBytes: 4 },
    downloadUrl: 'https://storage.example.test/jobs/101/input/original.media?X-Amz-Signature=sig',
    createdAt: '2026-10-14T10:00:00.000Z',
    ...overrides,
  };
}

export function jobDetail(overrides: Partial<JobDetail> = {}): JobDetail {
  return { ...job(), artifacts: [artifact()], ...overrides };
}

export function createResponse(slots: string[] = ['original'], options: { jobId?: string; expiresInMs?: number } = {}): CreateJobResponse {
  const jobId = options.jobId ?? '101';
  const expiresAt = new Date(Date.now() + (options.expiresInMs ?? 60_000)).toISOString();
  return {
    job: job({ id: jobId }),
    inputs: slots.map(slotName => ({
      slotName,
      uploadUrl: `https://storage.example.test/jobs/${jobId}/input/${slotName}.media?X-Amz-Signature=secret-signature`,
      uploadUrlExpiresAt: expiresAt,
    })),
  };
}

export function jobList(jobs: Job[], page: { limit?: number; offset?: number; total?: number } = {}): JobList {
  return { limit: page.limit ?? 20, offset: page.offset ?? 0, total: page.total ?? jobs.length, data: jobs };
}
