/**
 * The same flow as process(), one step at a time, plus listing recent jobs.
 *
 *   AUTHENTA_API_KEY=api_... npx ts-node examples/low-level.ts ./photo.jpg AC-1 image/jpeg
 *   AUTHENTA_API_KEY=api_... npx ts-node examples/low-level.ts ./contract.pdf PDF-1 application/pdf 4
 */

import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { AuthentaClient } from '../src';

async function main(): Promise<void> {
  const [path, model, contentType, pageCount] = process.argv.slice(2);
  const apiKey = process.env.AUTHENTA_API_KEY;
  if (!path || !model || !contentType || !apiKey) {
    console.error('Usage: AUTHENTA_API_KEY=... ts-node examples/low-level.ts <file> <model> <contentType> [pageCount]');
    process.exit(1);
  }
  const client = new AuthentaClient({ apiKey, ...(process.env.AUTHENTA_BASE_URL ? { baseUrl: process.env.AUTHENTA_BASE_URL } : {}) });
  const { size } = await stat(path);

  // 1. Create the job. This uses credits and is never retried automatically.
  const created = await client.jobs.create({
    taskTypeId: client.resolveModel(model),
    inputs: [
      {
        slotName: 'original',
        fileName: basename(path),
        contentType,
        sizeBytes: size,
        ...(pageCount ? { pageCount: Number(pageCount) } : {}),
      },
    ],
  });
  const jobId = created.job.id;
  const target = created.inputs[0];
  if (!target) throw new Error('No upload target returned');

  // 2. Upload the file. Upload links are short-lived, so this runs immediately.
  try {
    await client.uploads.put(target, path, { contentType, sizeBytes: size });
  } catch (error) {
    await client.jobs.cancel(jobId).catch(cancelError => console.error('cancel failed', cancelError));
    throw error;
  }

  // 3. Start processing, then 4. wait for the result.
  await client.jobs.finalize(jobId);
  const job = await client.jobs.waitForCompletion(jobId, { intervalMs: 3_000 });
  console.log(job.status, job.status === 'completed' ? await client.getResult(job) : '');

  // Recent jobs, newest first.
  const recent = await client.jobs.list({ limit: 5 });
  console.log(`${recent.total} jobs in total`, recent.data.map(item => `${item.id}:${item.status}`));
}

void main();
