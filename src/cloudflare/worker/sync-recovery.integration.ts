/// <reference types="@cloudflare/vitest-plugin/types" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schemaSql from '../schema.sql?raw';
import { sha256HexBytes } from './auth';
import { handleRestoreFileVersion } from './file-version-handlers';
import { sweepOrphanedManagedObjects } from './maintenance/orphan-sweep';
import { drainObjectCleanupQueue, enqueueExpiredFileVersions } from './sync-storage';
import type { Env } from './types';

const { DB: db, BUCKET: bucket }: Env = env;

beforeEach(async () => {
	for (const statement of schemaSql.split(';').map(value => value.trim()).filter(Boolean)) {
		await db.prepare(statement).run();
	}
});
afterEach(async () => {
	vi.restoreAllMocks();
	await reset();
});

async function retain(path: string, content: Uint8Array) {
	const hash = await sha256HexBytes(content);
	const key = `__crate__/files/${hash}/retained`;
	await bucket.put(key, content, { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { hash } });
	await db.prepare(`INSERT INTO file_versions (storage_key, path, hash, size, reason, expires_at)
		VALUES (?, ?, ?, ?, 'deleted', ?)`).bind(key, path, hash, content.byteLength, Date.now() + 60_000).run();
	return { hash, key };
}

function restore(key: string, expectedHash: string | null = null) {
	return handleRestoreFileVersion(new Request('https://example.test/versions/restore', {
		method: 'POST', body: JSON.stringify({ storageKey: key, expectedHash }),
	}), bucket, db);
}

describe('sync recovery', () => {
	it.each(['note.md', 'image.png', '.obsidian/snippets/test.css', 'script.js'])(
		'restores %s safely when its source expires during the request', async path => {
			const content = path.endsWith('.png') ? new Uint8Array([137, 80, 78, 71, 0, 255]) : new TextEncoder().encode('original content');
			const { key, hash } = await retain(path, content);
			const put = bucket.put.bind(bucket);
			vi.spyOn(bucket, 'put').mockImplementationOnce(async (...args) => {
				await enqueueExpiredFileVersions(db, Date.now() + 120_000);
				await drainObjectCleanupQueue(bucket, db);
				return put(...args);
			});
			expect((await restore(key)).status).toBe(200);
			const live = await db.prepare('SELECT storage_key, hash FROM files WHERE path = ?').bind(path)
				.first<{ storage_key: string; hash: string }>();
			expect(live?.hash).toBe(hash);
			expect(live?.storage_key).not.toBe(key);
			await drainObjectCleanupQueue(bucket, db);
			expect(await bucket.get(key)).toBeNull();
			const restored = await bucket.get(live!.storage_key);
			expect(new Uint8Array(await restored!.arrayBuffer())).toEqual(content);
			expect(restored!.httpMetadata?.contentType).toBe('application/octet-stream');
		},
	);

	it('rejects stale restores and removes only the unused staged copy', async () => {
		const { key } = await retain('note.md', new TextEncoder().encode('old'));
		await bucket.put('current', 'new');
		await db.prepare(`INSERT INTO files (path, portable_path, hash, size, storage_key)
			VALUES ('note.md', 'note.md', ?, 3, 'current')`).bind('b'.repeat(64)).run();
		expect((await restore(key, 'c'.repeat(64))).status).toBe(409);
		expect(await (await bucket.get('current'))!.text()).toBe('new');
		expect(await bucket.get(key)).not.toBeNull();
		expect((await bucket.list({ prefix: '__crate__/files/' })).objects).toHaveLength(1);
	});

	it('preserves committed bytes when the database response is lost', async () => {
		const { key } = await retain('note.md', new TextEncoder().encode('restored'));
		const batch = db.batch.bind(db);
		vi.spyOn(db, 'batch').mockImplementationOnce(async statements => {
			await batch(statements);
			throw new Error('response lost');
		});
		expect((await restore(key)).status).toBe(503);
		const live = await db.prepare('SELECT storage_key FROM files').first<{ storage_key: string }>();
		expect(await (await bucket.get(live!.storage_key))!.text()).toBe('restored');
	});

	it('sweeps full pages within D1 binding limits and preserves both kinds of references', async () => {
		const keys = Array.from({ length: 101 }, (_, index) => `__crate__/files/${String(index).padStart(3, '0')}`);
		await Promise.all(keys.map(key => bucket.put(key, 'data')));
		await db.prepare(`INSERT INTO files (path, portable_path, hash, size, storage_key)
			VALUES ('active.md', 'active.md', 'hash', 4, ?)`).bind(keys[0]).run();
		await db.prepare(`INSERT INTO file_versions (storage_key, path, hash, size, reason, expires_at)
			VALUES (?, 'retained.md', 'hash', 4, 'deleted', ?)`).bind(keys[99], Date.now() + 300_000).run();
		const prepare = db.prepare.bind(db);
		const bindingCounts: number[] = [];
		vi.spyOn(db, 'prepare').mockImplementation(sql => {
			const statement = prepare(sql);
			if (sql.includes('UNION SELECT storage_key')) {
				const bind = statement.bind.bind(statement);
				vi.spyOn(statement, 'bind').mockImplementation((...args) => {
					bindingCounts.push(args.length);
					if (args.length > 100) throw new Error('D1 binding limit exceeded');
					return bind(...args);
				});
			}
			return statement;
		});
		const now = Date.now() + 2 * 24 * 60 * 60 * 1000;
		expect(await sweepOrphanedManagedObjects(bucket, db, now)).toBe(98);
		expect(await db.prepare('SELECT value FROM maintenance_state').first()).not.toBeNull();
		expect(await sweepOrphanedManagedObjects(bucket, db, now)).toBe(1);
		expect(await db.prepare('SELECT value FROM maintenance_state').first()).toBeNull();
		expect(bindingCounts).toEqual([100, 100, 2]);
		expect((await bucket.list()).objects.map(object => object.key)).toEqual([keys[0], keys[99]]);
	});
});
