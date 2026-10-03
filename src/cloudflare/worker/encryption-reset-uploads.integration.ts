/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { fetchWorkerRequest } from './request-handler';
import { sha256Hex } from './auth';
import { readEncryptionState } from './encryption-state';
import { SYNC_RESET_GENERATION_KEY } from './sync-reset-generation';
import { createVaultKeyBundle, generateRecoveryCode } from '../../encryption/key-bundle';
import { convertEncryptedVault } from '../../sync/encryption-conversion';
import { WorkerApiHttpClient, type ApiHttpTransport } from '../../sync/worker-api/http';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol';
import { createReminderOperationId } from '../../protocol/reminder-operation';

const uploadKinds = ['single binary', 'single markdown', 'batch', 'bulk'] as const;
type UploadKind = typeof uploadKinds[number];
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current) });
const operationId = () => createReminderOperationId(Math.floor(Date.now() / 86400000));

beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('original', ?, 'vault')").bind(await sha256Hex('original')).run();
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

function upload(kind: UploadKind, token: string) {
	const content = 'content from this device\n';
	const paths = kind === 'single binary' ? ['late.bin'] : kind === 'single markdown' ? ['late.md'] : ['late.md', 'late.bin'];
	const batch = kind === 'batch' || kind === 'bulk';
	const body = batch ? JSON.stringify({ bulkNewFiles: kind === 'bulk', files: paths.map(path => ({
		path, content: btoa(content), expectedHash: null, operationId: operationId(),
		contentType: path.endsWith('.md') ? 'text/markdown' : 'application/octet-stream',
	})) }) : content;
	const url = batch ? 'https://test/sync/batch-upload' : `https://test/sync/upload?path=${paths[0]}`;
	const init = { method: batch ? 'POST' : 'PUT', headers: {
		...headers(token), 'Content-Type': batch ? 'application/json' : 'application/octet-stream',
		'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': operationId(),
	} };
	return { paths, body, url, init, request: new Request(url, { ...init, body }) };
}

const transport: ApiHttpTransport = async input => {
	const response = await worker.fetch(new Request(input.url, { method: input.method, body: input.body, headers: input.headers }), env);
	const arrayBuffer = await response.arrayBuffer(), responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => { responseHeaders[key] = value; });
	return { status: response.status, headers: responseHeaders, arrayBuffer, text: new TextDecoder().decode(arrayBuffer) };
};

async function enableAndReset(token: string, cycle: number) {
	await convertEncryptedVault(new WorkerApiHttpClient('https://test', token, transport), createVaultKeyBundle(), await generateRecoveryCode(), () => {});
	const state = (await readEncryptionState(env.DB))!;
	expect(state.mode).toBe('active');
	const id = `reset-cycle-${cycle}`, replacement = String(cycle).repeat(64);
	const call = (credential: string) => worker.fetch(new Request(`https://test/encryption/reset?id=${id}`, {
		method: 'POST', body: JSON.stringify({ confirmation: 'delete-remote-data', replacementToken: replacement }),
		headers: { ...headers(credential), 'X-Crate-Encryption-Vault': state.vaultId, 'X-Crate-Encryption-Generation': String(state.generation) },
	}), env);
	expect((await call(token)).status).toBe(200);
	let complete = false;
	for (let pass = 0; pass < 30 && !complete; pass++) {
		const response = await call(replacement);
		expect(response.status, await response.clone().text()).toBe(200);
		complete = (await response.json() as { complete: boolean }).complete;
	}
	expect(complete).toBe(true);
	expect(await readEncryptionState(env.DB)).toBeNull();
	expect(await env.DB.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(SYNC_RESET_GENERATION_KEY).first()).toEqual({ value: id });
	expect((await worker.fetch(new Request('https://test/health', { headers: headers(token) }), env)).status).toBe(401);
	return replacement;
}

async function expectFreshUpload(kind: UploadKind, token: string) {
	const fresh = upload(kind, token);
	const response = await worker.fetch(fresh.request, env);
	expect(response.status, await response.clone().text()).toBe(200);
	expect(await response.json()).toMatchObject({ success: true });
	expect((await env.DB.prepare('SELECT path FROM files ORDER BY path').all<{ path: string }>()).results.map(row => row.path)).toEqual([...fresh.paths].sort());
}

it.each(uploadKinds)('fences %s bodies delayed across activation and reset, including a second reset', async kind => {
	let token = 'original';
	for (const cycle of [1, 2]) {
		const stale = upload(kind, token);
		let opened!: () => void;
		const reading = new Promise<void>(resolve => { opened = resolve; });
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
		const original = new Request(stale.url, { ...stale.init, body });
		// Signal only when the handler reads the body, after authentication.
		const paused = new Proxy(original, { get(target, property) {
			if (property === 'body') { opened(); return target.body; }
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		} });
		const pending = worker.fetch(paused, env);
		try {
			await Promise.race([reading, pending.then(() => { throw new Error('Upload finished before its body was read'); })]);
			token = await enableAndReset(token, cycle);
		} finally {
			controller.enqueue(new TextEncoder().encode(stale.body)); controller.close();
			await pending;
		}
		const response = await pending;
		expect(response.status, await response.clone().text()).toBe(428);
		expect(await response.json()).toMatchObject({ code: 'encryption_required' });
		for (const table of ['files', 'changelog', 'staged_uploads', 'staged_upload_batches', 'upload_operations']) {
			expect(await env.DB.prepare(`SELECT 1 FROM ${table}`).first()).toBeNull();
		}
		expect((await env.BUCKET.list()).objects).toHaveLength(0);
		await expectFreshUpload(kind, token);
	}
});

it.each(uploadKinds)('rechecks the reset generation when publishing %s, even with a valid lease', async kind => {
	const stale = upload(kind, 'original');
	let release!: () => void, staged!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const ready = new Promise<void>(resolve => { staged = resolve; });
	const bucket = new Proxy(env.BUCKET, { get(target, property) {
		if (property === 'put') return async (...args: Parameters<R2Bucket['put']>) => { staged(); await gate; return target.put(...args); };
		const value: unknown = Reflect.get(target, property, target);
		return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
	} });
	// Inject the delayed R2 put at the transfer executor, where uploads now run.
	// The public-route cases above still exercise the real transfer boundary.
	const pending = fetchWorkerRequest(stale.request, { ...env, BUCKET: bucket }, undefined, true);
	try {
		await Promise.race([ready, pending.then(() => { throw new Error('Upload finished before staging'); })]);
		// Isolate the publication guard from reset's separate lease invalidation.
		// Markdown also exercises forwarding this snapshot through the coordinator.
		await env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)').bind(SYNC_RESET_GENERATION_KEY, 'new-reset').run();
	} finally { release(); await pending; }
	expect(await (await pending).json()).toMatchObject({ success: false });
	expect(await env.DB.prepare('SELECT 1 FROM files UNION SELECT 1 FROM changelog').first()).toBeNull();
	await expectFreshUpload(kind, 'original');
});
