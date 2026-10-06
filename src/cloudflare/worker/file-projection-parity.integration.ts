/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import type { BatchUploadResponse } from '@/protocol/sync-types';
import { commitNewFiles } from './bulk-new-file-commit';
import { commitStagedFile } from './sync-mutations';
import { handleBatchUpload } from './sync-batch/upload';
import { writeCommittedMarkdownFile } from './storage';

async function initialize() {
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
}
beforeEach(initialize);
afterEach(reset);

const repeatedId = '11111111-1111-4111-8111-111111111111';
const datedId = '22222222-2222-4222-8222-222222222222';
const undatedId = '33333333-3333-4333-8333-333333333333';
const reminder = (id: string, due = '') => `- [ ] Task ${due} <!-- crate-id:${id} -->`;
type FileInput = { path: string; content: string };

async function upload(files: FileInput[], bulkNewFiles: boolean) {
  const response = await handleBatchUpload(new Request('https://test/sync/batch-upload', {
    method: 'POST', body: JSON.stringify({ bulkNewFiles, files: files.map(file => ({
      ...file, content: btoa(file.content), expectedHash: null,
      operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)),
    })) }),
  }), env.BUCKET, env.DB, { commitUpload: commitStagedFile, commitNewFiles });
  expect(response.status).toBe(200);
  return response.json() as Promise<BatchUploadResponse>;
}

async function snapshot() {
  // Compare durable semantics rather than random revision/job tokens or clock time.
  return {
    files: (await env.DB.prepare('SELECT path, hash, size FROM files ORDER BY path').all()).results,
    sources: (await env.DB.prepare('SELECT file_path, reminder_id, due_key, occurrences FROM reminder_sources ORDER BY file_path, reminder_id').all()).results,
    verification: (await env.DB.prepare(`SELECT s.file_path, s.verified, s.parser_version, s.file_revision = f.storage_key AS current_revision
      FROM reminder_source_state s JOIN files f ON f.path = s.file_path ORDER BY s.file_path`).all()).results,
    occurrences: (await env.DB.prepare(`SELECT reminder_id, due_key, first_seen_at > 0 AS observed
      FROM reminder_occurrences ORDER BY reminder_id, due_key`).all()).results,
    jobs: (await env.DB.prepare(`SELECT path, last_error, length(job_token) > 0 AS has_token
      FROM notification_projection_jobs ORDER BY path`).all()).results,
    retries: (await env.DB.prepare('SELECT path, attempts, available_at, error FROM notification_file_retries ORDER BY path').all()).results,
  };
}

async function comparePaths(files: FileInput[], seed?: () => Promise<void>) {
  await seed?.();
  const single = await upload(files, false);
  const singleState = await snapshot();
  await reset();
  await initialize();
  await seed?.();
  const bulk = await upload(files, true);
  const bulkState = await snapshot();
  const results = (response: BatchUploadResponse) => response.results.map(result => ({
    path: result.path, success: result.success, hash: result.hash, code: result.code, currentHash: result.currentHash,
  })).sort((a, b) => a.path.localeCompare(b.path));
  expect(results(bulk)).toEqual(results(single));
  expect(bulkState).toEqual(singleState);
  return { response: bulk, state: bulkState };
}

it('publishes the same duplicate ownership, due keys and occurrence history through both upload paths', async () => {
  const { response, state } = await comparePaths([
    { path: 'Reminders/a.md', content: [reminder(repeatedId, '2099-01-02T10:00:00.000Z'),
      reminder(repeatedId, '2099-03-04'), reminder(datedId, '2099-05-06'), reminder(undatedId)].join('\n') },
    { path: 'Reminders/b.md', content: reminder(repeatedId, '2099-01-02T10:00:00.000Z') },
    { path: 'Outside.md', content: reminder(undatedId, '2099-05-06') },
  ]);
  expect(response.success).toBe(true);
  expect(state.sources).toEqual([
    { file_path: 'Reminders/a.md', reminder_id: repeatedId, due_key: '2099-01-02T10:00:00.000Z', occurrences: 2 },
    { file_path: 'Reminders/a.md', reminder_id: datedId, due_key: '2099-05-06', occurrences: 1 },
    { file_path: 'Reminders/a.md', reminder_id: undatedId, due_key: '', occurrences: 1 },
    { file_path: 'Reminders/b.md', reminder_id: repeatedId, due_key: '2099-01-02T10:00:00.000Z', occurrences: 1 },
  ]);
  expect(state.occurrences).toEqual([
    { reminder_id: repeatedId, due_key: '2099-01-02T10:00:00.000Z', observed: 1 },
    { reminder_id: datedId, due_key: '2099-05-06', observed: 1 },
  ]);
  expect(state.verification).toHaveLength(2);
  expect(state.verification).toEqual(expect.arrayContaining([
    expect.objectContaining({ file_path: 'Reminders/a.md', verified: 1, current_revision: 1 }),
    expect.objectContaining({ file_path: 'Reminders/b.md', verified: 1, current_revision: 1 }),
  ]));
  expect(state.jobs).toHaveLength(2);
  expect(state.retries).toEqual([]);
});

it('quarantines malformed source metadata without publishing its identities through either upload path', async () => {
  const { response, state } = await comparePaths([
    { path: 'Reminders/good.md', content: reminder(repeatedId, '2099-01-02T10:00:00.000Z') },
    { path: 'Reminders/bad.md', content: `${reminder(datedId, '2099-05-06')}\n<!-- crate-desc:v1:%invalid -->` },
  ]);
  expect(response.success).toBe(true);
  expect(state.sources).toHaveLength(1);
  expect(state.sources[0]).toMatchObject({ file_path: 'Reminders/good.md', reminder_id: repeatedId });
  expect(state.verification).toEqual(expect.arrayContaining([
    expect.objectContaining({ file_path: 'Reminders/bad.md', verified: 0, current_revision: 1 }),
  ]));
  expect(state.jobs).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'Reminders/bad.md', last_error: expect.stringContaining('Repair the reminder metadata') as string }),
  ]));
  expect(state.retries).toEqual([
    expect.objectContaining({ path: 'Reminders/bad.md', attempts: 1, available_at: -1 }),
  ]);
});

it('keeps rejected revisions out of source publication and revisits an existing duplicate owner', async () => {
  const original = reminder(repeatedId, '2099-01-02T10:00:00.000Z');
  const { response, state } = await comparePaths([
    { path: 'Reminders/existing.md', content: `${reminder(datedId)}\n<!-- crate-desc:v1:%invalid -->` },
    { path: 'Reminders/new.md', content: original },
  ], async () => {
    await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/existing.md', original, null);
    await env.DB.prepare('DELETE FROM notification_projection_jobs').run();
  });
  expect(response.results.find(result => result.path === 'Reminders/existing.md')).toMatchObject({ success: false, code: 'version_conflict' });
  expect(state.sources).toEqual([
    { file_path: 'Reminders/existing.md', reminder_id: repeatedId, due_key: '2099-01-02T10:00:00.000Z', occurrences: 1 },
    { file_path: 'Reminders/new.md', reminder_id: repeatedId, due_key: '2099-01-02T10:00:00.000Z', occurrences: 1 },
  ]);
  expect(state.verification).toEqual(expect.arrayContaining([
    expect.objectContaining({ file_path: 'Reminders/existing.md', verified: 1, current_revision: 1 }),
  ]));
  expect(state.jobs).toEqual([
    { path: 'Reminders/existing.md', last_error: null, has_token: 1 },
    { path: 'Reminders/new.md', last_error: null, has_token: 1 },
  ]);
  expect(state.retries).toEqual([]);
  const file = await env.DB.prepare("SELECT storage_key FROM files WHERE path = 'Reminders/existing.md'").first<{ storage_key: string }>();
  expect(await (await env.BUCKET.get(file!.storage_key))!.text()).toBe(original);
});
