/// <reference types="@cloudflare/vitest-plugin/types" />
// Runs against `.generated/cloudflare/worker.mjs`, the Worker the plugin deploys to Cloudflare,
// built without self-hosted features (see vitest.cloudflare-bundle.config.ts). Every other
// Worker runtime suite runs the self-hosted bundle.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from './test-support/schema-test-harness';
import { sha256Hex } from '@/platform/sha256';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { BATCH_UPLOAD_MAX_FILES, MAX_FILE_SIZE_BYTES } from '@/protocol/sync-limits';

const bindings = env as { CRATE_MAX_FILE_BYTES?: string };
/** The `main` Worker in wrangler.cloudflare.jsonc: the built Cloudflare bundle. */
const deployed = exports.default;
beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope) VALUES ('hosted', ?, 'vault')").bind(await sha256Hex('hosted-token')).run();
});
afterEach(async () => { delete bindings.CRATE_MAX_FILE_BYTES; await reset(); });

const request = (route: string, init: RequestInit = {}) => deployed.fetch(`https://hosted.test${route}`, { ...init, headers: {
	Authorization: 'Bearer hosted-token', 'X-Crate-Protocol': '1', ...init.headers,
} });
const operation = () => createReminderOperationId(Math.floor(Date.now() / 86400000));
const upload = (path: string, body: BodyInit, headers: Record<string, string> = {}) => request(`/sync/upload?path=${path}`, { method: 'PUT', body,
	headers: { 'X-Crate-Upload-Operation': operation(), 'X-Crate-Expected-Hash': 'absent', ...headers } });

it('answers server info exactly as before self-hosted limits: protocol 1, no limits, no chunked uploads', async () => {
	const info = await (await deployed.fetch('https://hosted.test/.well-known/crate')).json() as Record<string, unknown>;
	expect(info.protocol).toEqual({ current: 1, oldestCompatible: 1 });
	expect(info).not.toHaveProperty('limits');
	expect(info.capabilities).not.toContain('chunked-uploads-v1');
	expect(info.capabilities).toContain('sync-v1');
});

it('syncs a file in one request, ignores Range, and keeps the default limits even if the self-hosted binding is set', async () => {
	bindings.CRATE_MAX_FILE_BYTES = String(100 * 1024 * 1024);
	expect((await upload('note.md', 'hello')).status).toBe(200);
	const downloaded = await request('/sync/download?path=note.md', { headers: { Range: 'bytes=0-1' } });
	expect(downloaded.status).toBe(200);
	expect(downloaded.headers.get('Content-Range')).toBeNull();
	expect(await downloaded.text()).toBe('hello');
	expect((await upload('big.bin', 'x', { 'X-File-Size': String(MAX_FILE_SIZE_BYTES + 1) })).status).toBe(413);
	expect(((await (await deployed.fetch('https://hosted.test/.well-known/crate')).json()) as Record<string, unknown>).protocol).toEqual({ current: 1, oldestCompatible: 1 });
});

it('has no chunked upload routes', async () => {
	expect((await request('/sync/upload-session?action=begin', { method: 'POST', body: '{}', headers: { 'X-Crate-Upload-Operation': operation() } })).status).toBe(404);
	expect((await request('/sync/upload-session?part=1', { method: 'PUT', body: 'x', headers: { 'X-Crate-Upload-Operation': operation() } })).status).toBe(404);
});

it('keeps Cloudflare batch sizes and history periods', async () => {
	const files = Array.from({ length: BATCH_UPLOAD_MAX_FILES + 1 }, (_, index) => ({ path: `note-${index}.md`, content: btoa('x'), hash: '', size: 1,
		contentType: 'text/markdown', expectedHash: null, operationId: operation() }));
	expect((await request('/sync/batch-upload', { method: 'POST', body: JSON.stringify({ files }) })).status).toBe(400);
	const retention = await (await request('/history-retention')).json() as Record<string, unknown>;
	expect(retention).toEqual({ days: 30 });
	expect((await request('/history-retention', { method: 'POST', body: JSON.stringify({ days: 180 }) })).status).toBe(400);
	expect((await request('/history-retention', { method: 'POST', body: JSON.stringify({ days: 90 }) })).status).toBe(200);
});
