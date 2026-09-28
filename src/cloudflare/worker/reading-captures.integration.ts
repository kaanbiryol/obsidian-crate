/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { handleReadingRoute } from './reading/routes';
import { publishCapture, runCapture, type PendingCapture } from './reading/captures';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from './storage';
import { parseReadingNote } from '@/reading/core/notes';
import { commitFileDelete } from './sync-mutations';
import { getStoredFileRow } from './sync-storage';
const principal = { tokenId: 'vault', scope: 'vault' as const };
const operation = () => createReminderOperationId(Math.floor(Date.now() / 86400_000));
const command = (action: string, body: Record<string, unknown>) => handleReadingRoute(new Request(`https://test/reading/${action}`, { method: 'POST', body: JSON.stringify(body) }), env, principal);
const list = () => handleReadingRoute(new Request('https://test/reading/list'), env, principal);
beforeEach(async () => {
	await env.DB.batch(schema.split(';').map(s => s.trim()).filter(Boolean).map(s => env.DB.prepare(s)));
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','hash')").run();
	expect((await command('policy', { enabled: true, folderPath: 'Reading', revision: null })).status).toBe(200);
});
afterEach(reset);
async function capture(extra: Record<string, unknown> = {}) {
	const body = { url: 'https://example.com/article', operationId: operation(), ...extra };
	const response = await command('capture', body);
	expect(response.status, await response.clone().text()).toBe(200);
	return { body, response: await response.json() as unknown, row: (await env.DB.prepare('SELECT * FROM reading_captures').first<PendingCapture>())! };
}
it('queues durably with a receipt and publishes just one final named file', async () => {
	const { body, response, row } = await capture();
	expect(await env.DB.prepare('SELECT 1 FROM files').first()).toBeNull();
	expect(await env.DB.prepare('SELECT 1 FROM changelog').first()).toBeNull();
	expect(await (await list()).json()).toMatchObject({ items: [{ path: '', extraction_status: 'pending', crate_reading_id: row.id }] });
	expect(await (await command('capture', body)).json()).toEqual(response);
	expect(await (await command('capture', { ...body, operationId: operation() })).json()).toMatchObject({ alreadySaved: true, id: row.id });
	await publishCapture(env, row.id, row.generation, { markdown: 'Saved article.', title: 'Actual title' });
	const path = `Reading/Actual title - ${row.id.slice(0, 8)}.md`;
	const file = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!;
	expect(file.content).toContain('Saved article.');
	expect(parseReadingNote(file.content)).toMatchObject({ crate_reading_id: row.id, title: 'Actual title', extraction_status: 'ready' });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM changelog').first()).toMatchObject({ n: 1 });
	expect(await env.DB.prepare('SELECT 1 FROM reading_captures').first()).toBeNull();
	const stored = (await getStoredFileRow(env.DB, path))!;
	await commitFileDelete(env.BUCKET, env.DB, { path, previousFile: stored, expectedHash: stored.hash, expectedRevision: stored.storageKey });
	await publishCapture(env, row.id, row.generation, { markdown: 'Late delivery', title: 'Changed title' });
	expect(await (await command('capture', body)).json()).toEqual(response);
	expect(await env.DB.prepare('SELECT 1 FROM files').first()).toBeNull();
});
it('preserves occupied filenames and extends the short ID', async () => {
	const captureId = 'a1b2c3d4-5678-4abc-9def-123456789abc';
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Title - a1b2c3d4.md', 'Keep me', null);
	const { row } = await capture({ captureId, title: 'Title' });
	await publishCapture(env, row.id, row.generation, { markdown: 'Article', title: 'Extracted title' });
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, 'Reading/Title - a1b2c3d4.md'))?.content).toBe('Keep me');
	expect(await getStoredFileRow(env.DB, 'Reading/Title - a1b2c3d45678.md')).not.toBeNull();
});
it('publishes a fallback bookmark when fetching fails or consent is withdrawn', async () => {
	const { row } = await capture();
	const current = (await env.DB.prepare('SELECT revision FROM reading_policy').first<{ revision: string }>())!;
	expect((await command('policy', { enabled: false, folderPath: 'Reading', revision: current.revision })).status).toBe(200);
	const after = (await env.DB.prepare('SELECT revision FROM reading_policy').first<{ revision: string }>())!;
	expect((await command('policy', { enabled: false, folderPath: 'Other', revision: after.revision })).status).toBe(409);
	await publishCapture(env, row.id, row.generation, { markdown: 'Discard in-flight fetch', title: 'Title' });
	const file = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, `Reading/example.com - ${row.id.slice(0, 8)}.md`))!;
	expect(parseReadingNote(file.content)?.extraction_status).toBe('unavailable');
	expect(file.content).not.toContain('Discard');
});
it('rolls back enqueue if its receipt cannot commit', async () => {
	await env.DB.prepare("DELETE FROM auth_tokens WHERE id='vault'").run();
	await expect(command('capture', { url: 'https://example.com', operationId: operation() })).rejects.toThrow();
	expect(await env.DB.prepare('SELECT 1 FROM reading_captures').first()).toBeNull();
});

it('leases failed fetches durably and falls back after three attempts', async () => {
	const { row } = await capture();
	const fetch = vi.fn(async () => { throw new Error('Network unavailable'); });
	const setAlarm = vi.fn(async () => {});
	const state = { storage: { setAlarm } } as unknown as DurableObjectState;
	const runtime = { ...env, READING_FETCH: { fetch } };
	for (let attempt = 1; attempt <= 3; attempt++) {
		await env.DB.prepare('UPDATE reading_captures SET available_at=0 WHERE id=?').bind(row.id).run();
		await runCapture(runtime, state, true);
		if (attempt < 3) {
			expect(await env.DB.prepare('SELECT attempts FROM reading_captures WHERE id=?').bind(row.id).first()).toMatchObject({ attempts: attempt });
			expect(await env.DB.prepare('SELECT 1 FROM files').first()).toBeNull();
		}
	}
	expect(fetch).toHaveBeenCalledTimes(3);
	expect(setAlarm).toHaveBeenCalledTimes(3);
	expect(await env.DB.prepare('SELECT 1 FROM reading_captures').first()).toBeNull();
	const file = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, `Reading/example.com - ${row.id.slice(0, 8)}.md`))!;
	expect(parseReadingNote(file.content)?.extraction_status).toBe('unavailable');
});
