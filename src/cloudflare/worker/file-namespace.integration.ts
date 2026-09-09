/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256Hex } from './auth';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol';
import { assertPortablePaths } from '../../protocol/portable-path';
import { writeCommittedMarkdownFilePair } from './atomic-markdown-write';
import { FileNamespaceConflictError } from './file-namespace';

interface UploadedFile { path: string; hash: string; revision: string }

beforeEach(async () => {
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope) VALUES ('device', ?, 'vault')")
		.bind(await sha256Hex('namespace-token')).run();
});
afterEach(async () => { await reset(); });

function request(route: string, init: RequestInit = {}) {
	return worker.fetch(new Request(`https://namespace.test${route}`, {
		...init, headers: {
			Authorization: 'Bearer namespace-token', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current), ...init.headers,
		},
	}), env);
}

function upload(path: string, body = `content:${path}`, expectedHash = 'absent') {
	return request(`/sync/upload?path=${encodeURIComponent(path)}`, {
		method: 'PUT', body, headers: { 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)), 'X-Crate-Expected-Hash': expectedHash },
	});
}

async function create(path: string): Promise<UploadedFile> {
	const response = await upload(path);
	expect(response.status).toBe(200);
	return response.json() as Promise<UploadedFile>;
}

async function remove(file: UploadedFile) {
	const response = await request('/sync/delete', {
		method: 'POST', body: JSON.stringify({ path: file.path, expectedHash: file.hash, expectedRevision: file.revision }),
	});
	expect(response.status).toBe(200);
}

async function expectConflict(response: Response, path: string, conflictingPath: string) {
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ success: false, path, code: 'namespace_conflict', conflictingPath });
}

async function state() {
	const tables = ['files', 'changelog', 'file_versions', 'notification_projection_jobs', 'reminder_sources', 'reminder_operations'];
	return Promise.all(tables.map(async table => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results));
}

const conflicts = [
	['Projects.md', 'Projects.md/child.md'],
	['Projects.md/child.md', 'Projects.md'],
	['Projects.md', 'projects.md/child.md'],
	['projects.md/child.md', 'Projects.md'],
	['Café.md', 'cafe\u0301.md/child.md'],
	['cafe\u0301.md/child.md', 'Café.md'],
	['Notes/😀.md', 'Notes/😀.md/child.md'],
	['Notes/😀.md/child.md', 'Notes/😀.md'],
] as const;

it.each(conflicts)('rejects a namespace conflict without publishing effects: %s then %s', async (first, second) => {
	await create(first);
	const before = await state();
	await expectConflict(await upload(second), second, first);
	expect(await state()).toEqual(before);
	expect((await env.BUCKET.list()).objects).toHaveLength(1);
	const download = await request(`/sync/download?path=${encodeURIComponent(first)}`);
	expect(await download.text()).toBe(`content:${first}`);
});

it.each(conflicts)('serializes simultaneous publication of %s and %s', async (first, second) => {
	const responses = await Promise.all([upload(first), upload(second)]);
	expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
	const manifest = await (await request('/sync/manifest')).json() as { files: Record<string, unknown> };
	expect(Object.keys(manifest.files)).toHaveLength(1);
	expect(() => assertPortablePaths(Object.keys(manifest.files))).not.toThrow();
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM changelog').first()).toEqual({ count: 1 });
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM notification_projection_jobs').first()).toEqual({ count: 1 });
});

it('allows exact-path updates, safe siblings and directories sharing a prefix', async () => {
	const file = await create('Projects.md');
	expect((await upload(file.path, 'updated bytes', file.hash)).status).toBe(200);
	for (const path of ['Projects.md-copy', 'Projects/a.md', 'Projects/b.md']) await create(path);
	expect(await (await request('/sync/download?path=Projects.md')).text()).toBe('updated bytes');
});

it('rejects conflicting members of one upload batch without rejecting unrelated files', async () => {
	const response = await request('/sync/batch-upload', { method: 'POST', body: JSON.stringify({ files:
		['Projects.md', 'Projects.md/child.md', 'unrelated.md'].map(path => ({ path, content: btoa(path), operationId: createReminderOperationId(Math.floor(Date.now() / 86400000)), expectedHash: null })),
	}) });
	expect(response.status).toBe(200);
	const body = await response.json() as { results: Array<{ path: string; success: boolean; code?: string; status?: number }> };
	expect(body.results.filter(result => result.success)).toHaveLength(2);
	expect(body.results.find(result => !result.success)).toMatchObject({ code: 'namespace_conflict', status: 409 });
	expect(body.results.find(result => result.path === 'unrelated.md')?.success).toBe(true);
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM changelog').first()).toEqual({ count: 2 });
});

it.each(conflicts.slice(0, 2))('refuses to restore %s over the namespace occupied by %s', async (retainedPath, livePath) => {
	const retained = await create(retainedPath);
	await remove(retained);
	await create(livePath);
	const before = await state();
	await expectConflict(await request('/sync/restore-version', {
		method: 'POST', body: JSON.stringify({ storageKey: retained.revision, expectedHash: null }),
	}), retainedPath, livePath);
	expect(await state()).toEqual(before);
	// Removing the obstruction permits the retained content to be published.
	const live = await env.DB.prepare('SELECT hash, storage_key AS revision FROM files WHERE path = ?').bind(livePath).first<UploadedFile>();
	await remove({ ...live!, path: livePath });
	expect((await request('/sync/restore-version', {
		method: 'POST', body: JSON.stringify({ storageKey: retained.revision, expectedHash: null }),
	})).status).toBe(200);
});

it.each(conflicts.slice(0, 2))('leaves both move files unchanged when %s obstructs destination %s', async (obstruction, destination) => {
	await create(obstruction);
	const source = await create('source.md');
	const before = await state();
	await expect(writeCommittedMarkdownFilePair(env.BUCKET, env.DB, {
		source: { path: source.path, content: 'source remainder', expectedHash: source.hash },
		destination: { path: destination, content: 'moved reminder', expectedHash: null },
	})).rejects.toMatchObject({ name: 'FileNamespaceConflictError', path: destination, conflictingPath: obstruction });
	expect(await state()).toEqual(before);
});

it('rejects a move whose retained source file is also the destination parent', async () => {
	const source = await create('Projects.md');
	await expect(writeCommittedMarkdownFilePair(env.BUCKET, env.DB, {
		source: { path: source.path, content: 'source remainder', expectedHash: source.hash },
		destination: { path: `${source.path}/child.md`, content: 'moved reminder', expectedHash: null },
	})).rejects.toBeInstanceOf(FileNamespaceConflictError);
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM files').first()).toEqual({ count: 1 });
});
