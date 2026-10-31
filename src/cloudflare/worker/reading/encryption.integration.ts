/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { createEncryptionFixture } from '../test-support/encryption-test-harness';
import { EncryptedReadingApi } from '@/pwa/reading/encrypted-api';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { openFile } from '@/encryption/file-codec';
import { handleReadingRoute } from './routes';
import type { CapturedArticle } from '@/reading/extraction/types';
import type { ReadingItem } from '@/reading/core/model';
import { sha256Hex } from '@/platform/sha256';
import { resolveEncryptedPath } from '@/encryption/path-binding';
import { sealFolderLabel } from '@/encryption/folder-label';
import { importEncryptionSecret } from '@/encryption/envelope';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
const operation = () => createReminderOperationId(Math.floor(Date.now() / 86400_000));
async function setup(mode: 'active' | 'resetting' = 'active') {
	const { bundle, recovery, keys, state, paths } = await createEncryptionFixture(mode);
	// The server knows the Reading folder only by its tag and sealed label.
	const folder = await sealFolderLabel('Reading', paths, await importEncryptionSecret(bundle.vault), bundle.vaultId);
	const reading = { plain: 'Reading', wire: folder.wire };
	await env.DB.batch([
		env.DB.prepare('INSERT INTO server_state(id,encryption) VALUES (1,?)').bind(JSON.stringify(state)),
		env.DB.prepare('INSERT INTO maintenance_state(key,value) VALUES (?,?)').bind(`e2ee:folder:${folder.wire}`, folder.label),
		env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,1,?,'policy','revision')").bind(folder.wire),
		env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope,folder_path,reading_generation) VALUES ('reader',?,'reading',?,'policy')").bind(await sha256Hex('reader-token'), folder.wire),
	]);
	const headers = { Authorization: 'Bearer reader-token', 'X-Crate-Protocol': '1', 'X-Crate-Encryption-Vault': state.vaultId, 'X-Crate-Encryption-Generation': String(state.generation) };
	const request = (path: string, body?: string) => worker.fetch(new Request('https://test' + path, { method: body ? 'POST' : 'GET', headers, body }), env);
	const attempts = new Map<string, unknown>(), requests: string[] = [];
	let loseReply = false, beforeCommit: (() => Promise<unknown>) | undefined;
	const api = (captureArticle?: (url: string) => Promise<CapturedArticle>) => new EncryptedReadingApi({ captureArticle, folderPath: 'Reading', wireFolder: folder.wire, paths, generation: bundle.generation, authority: keys.forPath(`${folder.wire}/receipt.md`),
		request: async (path, body) => {
			if (beforeCommit && path.endsWith('encrypted-commit')) { const run = beforeCommit; beforeCommit = undefined; await run(); }
			if (body) requests.push(body); const response = await request(path, body); if (loseReply && path.endsWith('encrypted-commit') && response.ok) { loseReply = false; throw new Error('Lost reply'); } return response;
		},
		readAttempt: id => Promise.resolve(attempts.get(id)), writeAttempt: (id, value) => { attempts.set(id, value); return Promise.resolve(); },
		error: (message, status) => new Error(`${status}: ${message}`),
	});
	/** Open a stored note the way a device does, from its server path. */
	const open = (path: string, bytes: Uint8Array<ArrayBuffer>) => openFile(bytes, (metadataPath, sealed) => resolveEncryptedPath(paths, path, metadataPath, sealed, reading), keys.forPath(path));
	return { bundle, recovery, keys, state, folder, headers, request, api, open, attempts, requests, loseNextReply: () => { loseReply = true; },
		/** Run another client's change after the next attempt is built but before it commits. */
		beforeNextCommit: (run: () => Promise<unknown>) => { beforeCommit = run; } };
}
it('keeps Reading captures, content, edits and replay receipts encrypted across a lost response', async () => {
	const h = await setup(), body = JSON.stringify({ operationId: operation(), url: 'https://private.example/confidential-article', title: 'Private Reading title' });
	h.loseNextReply(); await expect(h.api().request('/reading/capture', body)).rejects.toThrow('Lost reply');
	const receipt = await h.api().request('/reading/capture', body) as { saved: boolean; id: string };
	expect(receipt.saved).toBe(true); expect(h.requests[0]).toBe(h.requests[1]);
	expect(h.requests.join()).not.toContain('confidential-article'); expect(h.requests.join()).not.toContain('Private Reading title');
	const library = await h.api().request('/reading/list') as { items: Array<{ crate_reading_id: string; favorite: boolean }> };
	expect(library.items).toHaveLength(1); expect(library.items[0]!.crate_reading_id).toBe(receipt.id);
	await h.api().request('/reading/update', JSON.stringify({ operationId: operation(), id: receipt.id, changes: { favorite: true }, before: { favorite: false } }));
	await expect(h.api().request('/reading/update', JSON.stringify({ operationId: operation(), id: receipt.id, changes: { favorite: false }, before: { favorite: false } }))).rejects.toThrow('changed on another device');
	await expect(h.api().request('/reading/update', JSON.stringify({ operationId: operation(), id: receipt.id, changes: { source_url: 'https://other.example' }, before: {} }))).rejects.toThrow('409:');
	const file = await env.DB.prepare('SELECT path,storage_key FROM files').first<{ path: string; storage_key: string }>();
	const bytes = new Uint8Array(await (await env.BUCKET.get(file!.storage_key))!.arrayBuffer());
	expect(new TextDecoder().decode(bytes)).not.toContain('confidential-article');
	const opened = await h.open(file!.path, bytes);
	expect(new TextDecoder().decode(opened.content)).toContain('favorite: true');
	// Only tags reach the server: the note and folder names stay encrypted.
	expect(file!.path.startsWith(`${h.folder.wire}/`)).toBe(true);
	expect(opened.metadata.path.startsWith('Reading/')).toBe(true);
	expect(h.requests.join()).not.toContain('Reading/');
	expect((await env.DB.prepare('SELECT * FROM reading_items').all()).results).toHaveLength(0);
	expect((await env.DB.prepare('SELECT * FROM reading_jobs').all()).results).toHaveLength(0);
});
it('deletes an encrypted note once across a lost response and refuses a stale delete', async () => {
	const h = await setup(), api = h.api();
	const saved = await api.request('/reading/capture', JSON.stringify({ operationId: operation(), url: 'https://private.example/delete', fetchArticle: false })) as { id: string };
	const { items: [item] } = await api.request('/reading/list') as { items: ReadingItem[] };
	const before = { reading_status: item!.reading_status, favorite: item!.favorite, tags: item!.tags };
	await expect(api.request('/reading/delete', JSON.stringify({ operationId: operation(), id: saved.id, before: { ...before, favorite: true } }))).rejects.toThrow('changed on another device');
	expect(await env.DB.prepare('SELECT 1 FROM files').first()).not.toBeNull();
	const body = JSON.stringify({ operationId: operation(), id: saved.id, before });
	h.loseNextReply(); await expect(api.request('/reading/delete', body)).rejects.toThrow('Lost reply');
	expect(await api.request('/reading/delete', body)).toEqual({ deleted: true, id: saved.id });
	expect(h.requests.at(-1)).toBe(h.requests.at(-2));
	expect(await env.DB.prepare('SELECT 1 FROM files').first()).toBeNull();
	expect((await h.api().request('/reading/list') as { items: ReadingItem[] }).items).toEqual([]);
});
async function concurrentEdit() {
	const h = await setup();
	const saved = await h.api().request('/reading/capture', JSON.stringify({ operationId: operation(), url: 'https://private.example/concurrent' })) as { id: string };
	const { items: [item] } = await h.api().request('/reading/list') as { items: ReadingItem[] };
	const otherDevice = (changes: object, before: object) => () => h.api().request('/reading/update', JSON.stringify({ operationId: operation(), id: saved.id, changes, before }));
	const id = operation(), favorite = JSON.stringify({ operationId: id, id: saved.id, changes: { favorite: true }, before: { favorite: item!.favorite } });
	const sent = () => h.requests.filter(body => (JSON.parse(body) as { operationId: string }).operationId === id);
	const opened = async () => (await h.api().request(`/reading/item?id=${saved.id}`) as { item: ReadingItem }).item;
	return { h, item: item!, id, favorite, sent, opened, otherDevice };
}
it('rebuilds an encrypted Reading edit once against a note another device changed', async () => {
	const { h, item, id, favorite, sent, opened, otherDevice } = await concurrentEdit();
	h.beforeNextCommit(otherDevice({ tags: ['other-device'] }, { tags: item.tags }));
	expect(await h.api().request('/reading/update', favorite)).toMatchObject({ saved: true, id: item.crate_reading_id });
	const [rejected, rebuilt] = sent();
	expect(sent()).toHaveLength(2); expect(rebuilt).not.toBe(rejected);
	expect((h.attempts.get(id) as { rejected?: true }).rejected).toBeUndefined();
	expect(await opened()).toMatchObject({ favorite: true, tags: ['other-device'] });
	// A retried delivery resends the rebuilt ciphertext and replays its receipt.
	expect(await h.api().request('/reading/update', favorite)).toMatchObject({ saved: true });
	expect(sent()).toHaveLength(3); expect(sent()[2]).toBe(rebuilt);
});
it('sends an encrypted Reading edit to review when its rebuild conflicts again', async () => {
	const first = await concurrentEdit();
	first.h.beforeNextCommit(async () => {
		await first.otherDevice({ tags: ['other-device'] }, { tags: first.item.tags })();
		first.h.beforeNextCommit(first.otherDevice({ reading_status: 'archived' }, { reading_status: first.item.reading_status }));
	});
	await expect(first.h.api().request('/reading/update', first.favorite)).rejects.toThrow('409: A note changed');
	expect(first.sent()).toHaveLength(2);
	expect((first.h.attempts.get(first.id) as { rejected?: true }).rejected).toBe(true);
	expect(await first.opened()).toMatchObject({ favorite: false, tags: ['other-device'], reading_status: 'archived' });
});
it('sends an encrypted Reading edit to review when another device changed the same field', async () => {
	const same = await concurrentEdit();
	same.h.beforeNextCommit(same.otherDevice({ favorite: true }, { favorite: same.item.favorite }));
	await expect(same.h.api().request('/reading/update', same.favorite)).rejects.toThrow('changed on another device');
	expect(same.sent()).toHaveLength(1);
	expect((same.h.attempts.get(same.id) as { rejected?: true }).rejected).toBe(true);
});
it('allows encryption discovery but rejects plaintext saves and sibling-folder access', async () => {
	const h = await setup();
	const response = await worker.fetch(new Request('https://test/reading/encryption', { headers: { Authorization: 'Bearer reader-token', 'X-Crate-Protocol': '1' } }), env);
	expect(response.status).toBe(200); const metadata = await response.text();
	for (const secret of [h.recovery, h.bundle.vault.secret, h.bundle.notifications.secret, h.bundle.seal.privateKey]) expect(metadata).not.toContain(secret);
	// Reading sessions receive the same public configuration as every other session.
	expect(JSON.parse(metadata)).toEqual({ encryption: h.state, folderLabel: h.folder.label });
	expect((await h.request('/sync/manifest')).status).toBe(403);
	expect((await h.request('/settings')).status).toBe(403);
	expect((await h.request('/reading/capture', JSON.stringify({ operationId: operation(), url: 'https://private.example' }))).status).toBe(428);
	const sibling = await h.request('/reading/encrypted-files?folderPath=Reminders');
	expect(sibling.status).toBe(403);
	expect(await sibling.json()).toMatchObject({ error: 'Unknown encrypted Reading folder' });
	expect((await h.request('/reminders/encrypted-files?folderPath=Reminders')).status).toBe(403);
	const manifest = await worker.fetch(new Request('https://test/notifications/manifest.json'), env);
	// Android shares stay on the device; the server only echoes a first-install form back.
	expect(await manifest.text()).toContain('share_target');
});

it('keeps article highlights, annotations, tags and archive changes encrypted and readable by another client', async () => {
	const h = await setup(), quote = 'Private highlighted passage';
	const api = h.api(async () => ({ markdown: quote, title: 'Private article' }));
	const saved = await api.request('/reading/capture', JSON.stringify({ operationId: operation(), url: 'https://private.example/highlights' })) as { id: string };
	const { items: [item] } = await api.request('/reading/list') as { items: ReadingItem[] };
	const highlight = { start: 0, end: quote.length, text: quote, id: crypto.randomUUID(), note: 'Private annotation' };
	const update = JSON.stringify({ operationId: operation(), id: saved.id,
		changes: { highlights: [highlight], tags: ['private-tag'], reading_status: 'archived' },
		before: { highlights: item!.highlights, tags: item!.tags, reading_status: item!.reading_status } });
	h.loseNextReply(); await expect(api.request('/reading/update', update)).rejects.toThrow('Lost reply');
	await api.request('/reading/update', update);
	expect(h.requests.at(-1)).toBe(h.requests.at(-2));
	const opened = await h.api().request(`/reading/item?id=${saved.id}`) as { item: ReadingItem; markdown: string };
	expect(opened.item.highlights?.[0]).toMatchObject({ text: quote, note: highlight.note });
	expect(opened.item.tags).toEqual(['private-tag']);
	expect(opened.item.reading_status).toBe('archived');
	expect(opened.markdown).toContain(`==${quote}==`);
	const file = await env.DB.prepare('SELECT storage_key FROM files').first<{ storage_key: string }>();
	const serverBytes = await (await env.BUCKET.get(file!.storage_key))!.text();
	const receipts = JSON.stringify((await env.DB.prepare('SELECT * FROM reminder_operations').all()).results);
	for (const secret of [quote, highlight.note, 'private-tag']) {
		expect(serverBytes).not.toContain(secret); expect(receipts).not.toContain(secret); expect(h.requests.join()).not.toContain(secret);
	}
});
it.each(['active', 'resetting'] as const)('blocks Shortcut preparation before parsing private content while %s', async mode => {
	await setup(mode);
	for (const path of ['/reading/shortcut/v1/prepare']) {
		const request = new Request('https://test' + path, {
			method: 'POST', headers: { 'X-Crate-Shortcut-Revision': '1' }, body: 'unparsed private content',
		});
		const response = await handleReadingRoute(request, env);
		expect(response.status).toBe(428);
		expect(request.bodyUsed).toBe(false);
	}
	expect(await env.DB.prepare('SELECT 1 FROM reading_handoffs').first()).toBeNull();
});

it('names captures after their title and renames a link-named note once a retry finds the title', async () => {
	const h = await setup();
	const titled = await h.api(async () => ({ markdown: 'Article text.', title: 'Private headline' }))
		.request('/reading/capture', JSON.stringify({ operationId: operation(), url: 'https://www.private.example/titled' })) as { id: string };
	const bare = await h.api().request('/reading/capture', JSON.stringify({ operationId: operation(), url: 'https://private.example/later', fetchArticle: false })) as { id: string };
	const names = async () => {
		const rows = (await env.DB.prepare('SELECT path, storage_key FROM files').all<{ path: string; storage_key: string }>()).results;
		return Promise.all(rows.map(async row => (await h.open(row.path, new Uint8Array(await (await env.BUCKET.get(row.storage_key))!.arrayBuffer()))).metadata.path));
	};
	expect((await names()).sort()).toEqual([`Reading/Private headline - private.example - ${titled.id.slice(0, 8)}.md`, `Reading/private.example - ${bare.id.slice(0, 8)}.md`]);
	// The retry creates the titled note and deletes the old one in one commit.
	await h.api(async () => ({ markdown: 'Later text.', title: 'Later headline' })).request('/reading/retry', JSON.stringify({ operationId: operation(), id: bare.id }));
	expect((await names()).sort()).toEqual([`Reading/Later headline - private.example - ${bare.id.slice(0, 8)}.md`, `Reading/Private headline - private.example - ${titled.id.slice(0, 8)}.md`]);
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM file_deletion_receipts').first()).toEqual({ count: 1 });
	const library = await h.api().request('/reading/list') as { items: ReadingItem[] };
	expect(library.items.find(item => item.crate_reading_id === bare.id)).toMatchObject({ title: 'Later headline', extraction_status: 'ready' });
	expect(h.requests.join()).not.toContain('headline');
});
