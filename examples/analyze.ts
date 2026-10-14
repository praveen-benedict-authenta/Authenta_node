/**
 * Process one file with a model code and print the result.
 *
 *   AUTHENTA_API_KEY=api_... npx ts-node examples/analyze.ts ./photo.jpg AC-1
 *   AUTHENTA_API_KEY=api_... npx ts-node examples/analyze.ts ./contract.pdf PDF-1 4
 */

import { AuthentaClient, JobCreationUncertainError, JobSubmissionError, JobTimeoutError } from '../src';

async function main(): Promise<void> {
  const [path, model, pageCount] = process.argv.slice(2);
  const apiKey = process.env.AUTHENTA_API_KEY;
  if (!path || !model || !apiKey) {
    console.error('Usage: AUTHENTA_API_KEY=... ts-node examples/analyze.ts <file> <model> [pageCount]');
    process.exit(1);
  }

  const client = new AuthentaClient({ apiKey, ...(process.env.AUTHENTA_BASE_URL ? { baseUrl: process.env.AUTHENTA_BASE_URL } : {}) });

  try {
    const { job } = await client.process(path, {
      model,
      ...(pageCount ? { pageCount: Number(pageCount) } : {}),
      ...(model.toUpperCase() === 'FI-1' ? { livenessCheck: true } : {}),
      polling: {
        intervalMs: 3_000,
        timeoutMs: 10 * 60_000,
        onStatusChange: current => console.log(`job ${current.id}: ${current.status}`),
      },
    });

    console.log(`final status: ${job.status}`);
    if (job.status === 'completed') console.log('result:', JSON.stringify(await client.getResult(job), null, 2));
    for (const artifact of client.artifacts.list(job)) {
      console.log(`artifact ${artifact.id}: ${artifact.kind} (${artifact.contentType})`);
    }
  } catch (error) {
    if (error instanceof JobCreationUncertainError) {
      console.error('Job creation outcome unknown. Check jobs.list() before retrying:', error.message);
    } else if (error instanceof JobSubmissionError) {
      console.error(`Job ${error.jobId} failed during ${error.stage}; cancelled: ${error.cleanup.succeeded}`, error.cause);
    } else if (error instanceof JobTimeoutError) {
      console.error(`Job ${error.jobId} still ${error.lastJob.status}; poll it again later.`);
    } else {
      throw error;
    }
    process.exitCode = 1;
  }
}

void main();
