/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { handleBatchUpload } from './sync-batch/upload';
import type { BatchUploadResponse } from '@/protocol/sync-types';

beforeEach(async () => {
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

// Server-side comparison in local workerd + D1 + R2, not an internet speed claim.
it('compares 8000 new Markdown files at four concurrent requests', { timeout: 900_000 }, async () => {
  const measurements: Array<{ mode: string; files: number; requests: number; statements: number; transactions: number; wallMs: number }> = [];
  for (const bulkNewFiles of [false, true]) {
    const mode = bulkNewFiles ? 'bulk' : 'previous';
    const files = Array.from({ length: 8000 }, (_, index) => ({
      path: `${mode}/group-${index % 100}/note-${index}.md`, content: btoa(`# Note ${index}\n${'Ordinary Markdown content. '.repeat(40)}`),
      expectedHash: null, operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)),
    }));
    const prepare = vi.spyOn(env.DB, 'prepare'); const batch = vi.spyOn(env.DB, 'batch');
    const chunkSize = bulkNewFiles ? 8 : 3;
    let next = 0; let requests = 0; let completed = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < files.length) {
        const offset = next; next += chunkSize;
        const chunk = files.slice(offset, offset + chunkSize);
        const response = await handleBatchUpload(new Request('https://test/sync/batch-upload', {
          method: 'POST', body: JSON.stringify({ files: chunk, bulkNewFiles }),
        }), env.BUCKET, env.DB);
        const body = await response.json() as BatchUploadResponse;
        expect(body.success, JSON.stringify(body)).toBe(true);
        expect(body.results).toHaveLength(chunk.length);
        requests++; completed += chunk.length;
        if (completed % 1000 < chunkSize) console.info(`${mode}: ${completed}/8000 files`);
      }
    }));
    measurements.push({ mode, files: files.length, requests, statements: prepare.mock.calls.length,
      transactions: batch.mock.calls.length, wallMs: Math.round(performance.now() - started) });
    prepare.mockRestore(); batch.mockRestore();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM files WHERE path LIKE ?').bind(`${mode}/%`).first()).toEqual({ n: 8000 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM reminder_source_state WHERE file_path LIKE ? AND verified = 1').bind(`${mode}/%`).first()).toEqual({ n: 8000 });
  }
  console.info('BULK_UPLOAD_BENCHMARK', JSON.stringify(measurements));
  expect(measurements[1]!.statements).toBeLessThan(measurements[0]!.statements);
  expect(measurements[1]!.transactions).toBe(1000);
});
