/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schemaSql from '../schema.sql?raw';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '../../protocol';
import type { FileManifest, FileMetadataResponse, UploadResult } from '../../protocol/sync-types';
import { sha256Hex } from './auth';
import worker from './index';

const paths = ['__proto__', 'constructor', 'toString'];
const authToken = 'path-records-vault-token';

beforeEach(async () => {
	for (const sql of schemaSql.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	await env.DB.prepare('INSERT INTO auth_tokens (id, token_hash, scope, expires_at) VALUES (?, ?, ?, ?)')
		.bind('path-records-device', await sha256Hex(authToken), 'vault', Date.now() + 60_000).run();
});
afterEach(async () => { await reset(); });

function request(path: string, init: RequestInit = {}) {
	return worker.fetch(new Request(`https://worker.test${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${authToken}`,
			[CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current),
			...init.headers,
		},
	}), env);
}

describe('literal filenames through the Worker and D1/R2', () => {
	it('uploads, pages, downloads and deletes prototype-named files without dropping metadata', async () => {
		for (const path of paths) {
			const response = await request(`/sync/upload?path=${encodeURIComponent(path)}`, {
				method: 'PUT', headers: { 'X-Crate-Expected-Hash': 'absent', 'Content-Type': 'text/plain' }, body: `content:${path}`,
			});
			expect(response.status).toBe(200);
			expect(await response.json() as UploadResult).toMatchObject({ path, success: true });
		}

		// Every page is loaded from a fresh request against persisted D1/R2 state.
		const listedPaths: string[] = [];
		let after: string | undefined;
		for (let index = 0; index < paths.length; index++) {
			const query = new URLSearchParams({ limit: '1', ...(after ? { after } : {}) });
			const response = await request(`/sync/manifest?${query}`);
			expect(response.status).toBe(200);
			const page = await response.json() as FileManifest;
			expect(Object.keys(page.files)).toHaveLength(1);
			listedPaths.push(...Object.keys(page.files));
			expect(page.hasMore).toBe(index < paths.length - 1);
			after = page.nextCursor;
		}
		expect(listedPaths).toEqual(paths);

		const metadataResponse = await request('/sync/metadata', {
			method: 'POST', body: JSON.stringify({ paths: [...paths, 'missing'] }),
		});
		expect(metadataResponse.status).toBe(200);
		const metadata = await metadataResponse.json() as FileMetadataResponse;
		expect(Object.keys(metadata.files).sort()).toEqual(paths);
		for (const path of paths) {
			const entry = metadata.files[path]!;
			expect(entry.hash).toBe(await sha256Hex(`content:${path}`));
			expect(entry.revision).toBeTruthy();
			const download = await request(`/sync/download?path=${encodeURIComponent(path)}`);
			expect(download.status).toBe(200);
			expect(await download.text()).toBe(`content:${path}`);
		}

		const deleted = await request('/sync/batch-delete', {
			method: 'POST', body: JSON.stringify({ files: paths.map(path => ({
				path, expectedHash: metadata.files[path]!.hash, expectedRevision: metadata.files[path]!.revision,
			})) }),
		});
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toMatchObject({ success: true, deleted: paths });
		const manifest = await (await request('/sync/manifest')).json() as FileManifest;
		expect(Object.keys(manifest.files)).toEqual([]);
		const absent = await (await request('/sync/metadata', {
			method: 'POST', body: JSON.stringify({ paths }),
		})).json() as FileMetadataResponse;
		expect(Object.keys(absent.files)).toEqual([]);
		for (const path of paths) {
			expect((await request(`/sync/download?path=${encodeURIComponent(path)}`)).status).toBe(404);
		}
	});
});
