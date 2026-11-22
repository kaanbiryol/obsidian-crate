import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVaultKeyBundle } from '@/encryption/key-bundle';
import { encryptJson, importEncryptionSecret } from '@/encryption/envelope';
import { sha256Hex } from '@/platform/sha256';
import { importNotificationFingerprintKey } from '@/encryption/notification-keys';
import { importSealPrivateKey } from '@/encryption/seal-key';
import { EncryptedReminderApi, type EncryptedReminderStore } from './encrypted-reminder-api';
import type { EncryptedReminderAttempt, IndexedReminderNote } from './encrypted-reminder-attempts';
import type { ApiFetch } from '../types';
import type { FeatureKeys } from '../encryption/encryption-keys';
import { openFile, sealFile } from '@/encryption/file-codec';
import type { ReminderRecord } from './types';
import { derivePathTagKey, PathTags } from '@/encryption/path-tags';

const attempts = new Map<string, unknown>();
const indexes = new Map<string, { identity: string; notes: unknown }>();
const store: EncryptedReminderStore = {
	loadAttempt: async id => attempts.get(id) as EncryptedReminderAttempt | undefined,
	saveAttempt: async (id, value) => { attempts.set(id, value); },
	pruneAttempts: async (_scope, _day, _current, after) => after,
	loadIndex: async (scope, identity) => indexes.get(scope)?.identity === identity ? structuredClone(indexes.get(scope)!.notes) as IndexedReminderNote[] : undefined,
	saveIndex: vi.fn(async (scope: string, identity: string, notes: unknown) => { indexes.set(scope, { identity, notes: structuredClone(notes) }); }),
};
const client = (fetch: ApiFetch, current = () => true) => new EncryptedReminderApi(keys, fetch, { store, current });

let keys: FeatureKeys;
beforeEach(async () => {
	attempts.clear(); indexes.clear();
	// Without Web Locks the client skips background attempt cleanup.
	vi.stubGlobal('navigator', {});
	const bundle = await createVaultKeyBundle();
	const pathTag = await derivePathTagKey(bundle.vaultId, bundle.vault), paths = new PathTags(pathTag);
	keys = { version: 1, vaultId: bundle.vaultId, folderPath: 'Reminders', wireFolder: await paths.wire('Reminders'), paths, pathTag, readingSearch: pathTag,
		generation: bundle.generation, vault: await importEncryptionSecret(bundle.vault),
		notifications: await importEncryptionSecret(bundle.notifications),
		notificationFingerprint: await importNotificationFingerprintKey(bundle.vaultId, bundle.notifications),
		seal: { keyId: bundle.seal.id, publicKey: bundle.seal.publicKey, privateKey: await importSealPrivateKey(bundle.seal) }, localState: 'unused' };
});
afterEach(() => vi.unstubAllGlobals());
const token = (snapshot: number) => snapshot.toString(16).padStart(32, '0');
const etag = (snapshot: number) => `"e2ee-${keys.vaultId}-${keys.generation}-${token(snapshot)}"`;
const page = (snapshot: number, nextCursor: string | null = null) => ({ files: [], generation: keys.generation, changeToken: token(snapshot), deltaBase: `${snapshot}.${'b'.repeat(32)}`, nextCursor });
const isInventory = (route: string) => route.startsWith('/reminders/encrypted-files?');
const isDownload = (route: string) => route === '/reminders/encrypted-files/download';

interface Note { path: string; wire: string; sealed: Awaited<ReturnType<typeof sealFile>> }
async function note(path: string, text: string | Uint8Array<ArrayBuffer>): Promise<Note> {
	const content = typeof text === 'string' ? new TextEncoder().encode(text) : text;
	const sealed = await sealFile({ path, content, publicData: { version: 1, reminders: [] } }, { vaultId: keys.vaultId, scopeId: 'vault', key: keys.vault });
	return { path, wire: await keys.paths.wire(path), sealed };
}
const entry = ({ wire, sealed }: Note) => ({ path: wire, hash: sealed.hash, size: sealed.bytes.length, revision: sealed.hash });

/** A Worker that keeps every folder snapshot, so it answers 304s, deltas and batch downloads
 * as the real one does. `set` publishes a new snapshot. */
function server(initial: Note[] = []) {
	let current = 1;
	const snapshots = new Map([[current, new Map(initial.map(value => [value.wire, value]))]]);
	const notes = () => snapshots.get(current)!;
	// `downloads` answers a batch entry before the current snapshot does.
	const downloads = new Map<string, Record<string, unknown>>();
	const fetch = vi.fn(async (route: string, init?: RequestInit): Promise<Response> => {
		if (isDownload(route)) {
			const { files } = JSON.parse(init!.body as string) as { files: Array<{ path: string; revision: string }> };
			return Response.json({ files: files.map(({ path, revision }) => {
				const answer = downloads.get(path);
				if (answer) { downloads.delete(path); return { path, revision, ...answer }; }
				const value = notes().get(path);
				if (!value) return { path, revision, error: 'Note not found', code: 'not_found' };
				if (value.sealed.hash !== revision) return { path, revision, error: 'Note changed', code: 'version_conflict' };
				return { path, revision, hash: value.sealed.hash, size: value.sealed.bytes.length, content: new TextDecoder().decode(value.sealed.bytes) };
			}) });
		}
		if (!isInventory(route)) throw new Error(`Unexpected request ${route}`);
		if (new Headers(init?.headers).get('If-None-Match') === `"${token(current)}"`) return new Response(null, { status: 304 });
		const since = new URL(route, 'https://x').searchParams.get('since');
		const base = since ? snapshots.get(Number(since.split('.')[0])) : undefined;
		if (base) {
			const changed = [...notes().values()].filter(value => base.get(value.wire)?.sealed.hash !== value.sealed.hash);
			const removed = [...base.keys()].filter(wire => !notes().has(wire));
			return Response.json({ ...page(current), delta: true, files: changed.map(entry), removed, nextCursor: undefined });
		}
		return Response.json({ ...page(current), files: [...notes().values()].map(entry) });
	});
	return { fetch, downloads, set(next: Note[]) { snapshots.set(++current, new Map(next.map(value => [value.wire, value]))); } };
}
const routes = (fetch: ReturnType<typeof server>['fetch']) => fetch.mock.calls.map(([route]) => isInventory(route) ? 'inventory' : isDownload(route) ? 'download' : route);
const list = async (api: EncryptedReminderApi, previous?: string) => {
	const response = (await api.handle('/reminders/list?folderPath=Reminders', previous ? { headers: { 'If-None-Match': previous } } : {}))!;
	return { response, body: response.status === 200 ? await response.json() as { reminders: ReminderRecord[]; issues: Array<{ path: string }> } : undefined };
};

it('answers an unchanged list from the server 304, which reads no folder rows', async () => {
	const fetch = vi.fn(async (_route: string, init?: RequestInit) => new Headers(init?.headers).get('If-None-Match') === `"${token(7)}"`
		? new Response(null, { status: 304 }) : Response.json(page(8)));
	const response = await client(fetch).handle('/reminders/list?folderPath=Reminders', { headers: { 'If-None-Match': etag(7) } });
	expect(response?.status).toBe(304);
	expect(response?.headers.get('ETag')).toBe(etag(7));
	expect(fetch).toHaveBeenCalledOnce();
});

it('polls an unchanged folder with one conditional request and no downloads', async () => {
	const fake = server([await note('Reminders/Inbox.md', '- [ ] Inbox task <!-- crate-id:inbox -->\n')]);
	const api = client(fake.fetch);
	const first = await list(api);
	expect(routes(fake.fetch)).toEqual(['inventory', 'download']);
	fake.fetch.mockClear();
	const unchanged = await list(api, first.response.headers.get('ETag')!);
	expect(unchanged.response.status).toBe(304);
	// Without the app's ETag the list comes from the kept snapshot and parsed notes.
	const rebuilt = await list(api);
	expect(rebuilt.body!.reminders.map(reminder => reminder.id)).toEqual(['inbox']);
	expect(routes(fake.fetch)).toEqual(['inventory', 'inventory']);
	expect(fake.fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get('If-None-Match') === `"${token(1)}"`)).toBe(true);
});

it('applies a delta of changed and removed notes, downloading only the changed one', async () => {
	const inbox = await note('Reminders/Inbox.md', '- [ ] Inbox task <!-- crate-id:inbox -->\n');
	const work = await note('Reminders/Work.md', '- [ ] Work task <!-- crate-id:work -->\n');
	const home = await note('Reminders/Home.md', '- [ ] Home task <!-- crate-id:home -->\n');
	const fake = server([inbox, work, home]);
	const api = client(fake.fetch);
	const first = await list(api);
	const edited = await note('Reminders/Work.md', '- [ ] Edited work task <!-- crate-id:work -->\n');
	fake.set([inbox, edited]);
	fake.fetch.mockClear();
	const changed = await list(api, first.response.headers.get('ETag')!);
	expect(changed.response.headers.get('ETag')).toBe(etag(2));
	expect(changed.body!.reminders.map(reminder => reminder.content).sort()).toEqual(['Edited work task', 'Inbox task']);
	expect(new URL(fake.fetch.mock.calls[0]![0], 'https://x').searchParams.get('since')).toBe(`1.${'b'.repeat(32)}`);
	const [, download] = fake.fetch.mock.calls;
	expect(routes(fake.fetch)).toEqual(['inventory', 'download']);
	expect(JSON.parse(download![1]!.body as string)).toEqual({ folderPath: keys.wireFolder, files: [{ path: edited.wire, revision: edited.sealed.hash }] });
});

it('falls back to a full listing when the server cannot answer a delta', async () => {
	const inbox = await note('Reminders/Inbox.md', '- [ ] Inbox task <!-- crate-id:inbox -->\n');
	const fetch = vi.fn(async (route: string, _init?: RequestInit) => isDownload(route)
		? Response.json({ files: [{ path: inbox.wire, revision: inbox.sealed.hash, hash: inbox.sealed.hash, size: inbox.sealed.bytes.length, content: new TextDecoder().decode(inbox.sealed.bytes) }] })
		: Response.json({ ...page(fetch.mock.calls.length), files: [entry(inbox)] }));
	const api = client(fetch);
	await list(api);
	const again = await list(api);
	expect(again.body!.reminders.map(reminder => reminder.id)).toEqual(['inbox']);
	// The parsed note is reused; only the inventory was read again.
	expect(routes(fetch)).toEqual(['inventory', 'download', 'inventory']);
});

it('downloads a cold folder in batches of at most 50 notes, keeping note order and issues', async () => {
	const notes = await Promise.all(Array.from({ length: 120 }, (_, index) => note(`Reminders/N${String(index).padStart(3, '0')}.md`,
		index === 3 ? new Uint8Array([0xff, 0xfe, 0xfd]) : `- [ ] Task ${index} <!-- crate-id:t${index} -->\n`)));
	const fake = server(notes);
	const { body } = await list(client(fake.fetch));
	expect(routes(fake.fetch)).toEqual(['inventory', 'download', 'download', 'download']);
	expect(fake.fetch.mock.calls.slice(1).map(([, init]) => (JSON.parse(init!.body as string) as { files: unknown[] }).files.length).sort()).toEqual([20, 50, 50]);
	expect(body!.reminders.map(reminder => reminder.id)).toEqual(Array.from({ length: 120 }, (_, index) => `t${index}`).filter(id => id !== 't3'));
	expect(body!.issues.map(issue => issue.path)).toEqual(['Reminders/N003.md']);
}, 60_000);

it('lists again when a note changes between the inventory and its download', async () => {
	const original = await note('Reminders/Inbox.md', '- [ ] Original <!-- crate-id:task -->\n');
	const edited = await note('Reminders/Inbox.md', '- [ ] Edited <!-- crate-id:task -->\n');
	const fake = server([original]);
	// The edit lands after the inventory listed the original revision.
	fake.fetch.mockImplementationOnce(async (route, init) => {
		const response = await fake.fetch.getMockImplementation()!(route, init);
		fake.set([edited]);
		return response;
	});
	const { body } = await list(client(fake.fetch));
	expect(body!.reminders.map(reminder => reminder.content)).toEqual(['Edited']);
	expect(routes(fake.fetch)).toEqual(['inventory', 'download', 'inventory', 'download']);
});

it('drops a note deleted after it was listed, and gives up when the folder never settles', async () => {
	const inbox = await note('Reminders/Inbox.md', '- [ ] Inbox <!-- crate-id:inbox -->\n');
	const gone = await note('Reminders/Gone.md', '- [ ] Gone <!-- crate-id:gone -->\n');
	const fake = server([inbox, gone]);
	fake.fetch.mockImplementationOnce(async (route, init) => {
		const response = await fake.fetch.getMockImplementation()!(route, init);
		fake.set([inbox]);
		return response;
	});
	const { body } = await list(client(fake.fetch));
	expect(body!.reminders.map(reminder => reminder.id)).toEqual(['inbox']);

	const stuck = server([gone]);
	stuck.fetch.mockImplementation(async (route, init) => {
		if (isDownload(route)) {
			const { files } = JSON.parse(init!.body as string) as { files: Array<{ path: string; revision: string }> };
			return Response.json({ files: files.map(file => ({ ...file, error: 'Note not found', code: 'not_found' })) });
		}
		return Response.json({ ...page(stuck.fetch.mock.calls.length), files: [entry(gone)] });
	});
	await expect(list(client(stuck.fetch))).rejects.toThrow('changed while loading');
	expect(routes(stuck.fetch).filter(route => route === 'download')).toHaveLength(3);
});

it('reports a download the server could not read without listing it as a reminder note', async () => {
	const inbox = await note('Reminders/Inbox.md', '- [ ] Inbox <!-- crate-id:inbox -->\n');
	const fake = server([inbox]);
	fake.downloads.set(inbox.wire, { error: 'Note is unavailable', code: 'unavailable' });
	await expect(list(client(fake.fetch))).rejects.toThrow('Note is unavailable');
	fake.downloads.set(inbox.wire, { content: 'tampered', hash: inbox.sealed.hash, size: inbox.sealed.bytes.length });
	await expect(list(client(fake.fetch))).rejects.toThrow('integrity');
});

it('pages a full listing and rejects pages from another snapshot', async () => {
	const fetch = vi.fn()
		.mockResolvedValueOnce(Response.json(page(8, 'Reminders/next.md')))
		.mockResolvedValueOnce(Response.json(page(8)));
	const response = await client(fetch).handle('/reminders/list?folderPath=Reminders', { headers: { 'If-None-Match': etag(7) } });
	expect(response?.status).toBe(200);
	expect(response?.headers.get('ETag')).toBe(etag(8));
	// The Worker reads each page between two equal change tokens, so nothing confirms afterwards.
	expect(fetch).toHaveBeenCalledTimes(2);
	expect(fetch.mock.calls[1]?.[0]).toContain('after=Reminders%2Fnext.md');
});

it('does not acknowledge an unchanged snapshot after the session changes', async () => {
	let signedIn = true;
	const fetch = vi.fn(async () => { signedIn = false; return new Response(null, { status: 304 }); });
	await expect(client(fetch, () => signedIn).handle('/reminders/list?folderPath=Reminders', { headers: { 'If-None-Match': etag(7) } })).rejects.toThrow('Session changed');
});

it('validates encryption generation before using a listing', async () => {
	const fetch = vi.fn(async () => Response.json({ ...page(7), generation: keys.generation + 1 }));
	await expect(client(fetch).handle('/reminders/list?folderPath=Reminders', { headers: { 'If-None-Match': etag(6) } })).rejects.toThrow('Invalid encrypted file inventory');
});

it('rejects a delta when it holds no snapshot to apply it to', async () => {
	const fetch = vi.fn(async () => Response.json({ ...page(7), delta: true, removed: [], nextCursor: undefined }));
	await expect(client(fetch).handle('/reminders/list?folderPath=Reminders')).rejects.toThrow('Invalid encrypted file inventory');
});

it('bounds empty advancing encrypted pages independently of the file budget', async () => {
	const fetch = vi.fn(async () => Response.json(page(7, `cursor-${String(fetch.mock.calls.length).padStart(5, '0')}`)));
	await expect(client(fetch).handle('/reminders/list?folderPath=Reminders')).rejects.toThrow('limit');
	expect(fetch).toHaveBeenCalledTimes(1000);
});

it.each([['A', 'A'], ['A', 'B', 'A']])('rejects an encrypted cursor cycle: %j', async (...cursors) => {
	const fetch = vi.fn();
	for (const cursor of cursors) fetch.mockResolvedValueOnce(Response.json(page(7, cursor)));
	await expect(client(fetch).handle('/reminders/list?folderPath=Reminders')).rejects.toThrow('did not advance');
	expect(fetch).toHaveBeenCalledTimes(cursors.length);
});

it('rejects a malformed later page before downloading any files', async () => {
	const fetch = vi.fn().mockResolvedValueOnce(Response.json(page(7, 'A')))
		.mockResolvedValueOnce(Response.json({ ...page(7), files: [null] }));
	await expect(client(fetch).handle('/reminders/list?folderPath=Reminders')).rejects.toThrow('Invalid encrypted file');
	expect(fetch).toHaveBeenCalledTimes(2);
});

it('rejects duplicate paths before downloading or projecting files', async () => {
	const file = { path: await keys.paths.wire('Reminders/Inbox.md'), hash: 'a'.repeat(64), revision: 'first', size: 12 };
	const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...page(7, 'A'), files: [file] }))
		.mockResolvedValueOnce(Response.json({ ...page(7), files: [file] }));
	await expect(client(fetch).handle('/reminders/list?folderPath=Reminders')).rejects.toThrow('repeated a file');
	expect(fetch).toHaveBeenCalledTimes(2);
});

it('rejects repeated paths in a single page', async () => {
	const file = { path: await keys.paths.wire('Reminders/Inbox.md'), hash: 'a'.repeat(64), revision: 'first', size: 12 };
	const fetch = vi.fn(async () => Response.json({ ...page(7), files: [file, file] }));
	await expect(client(fetch).handle('/reminders/list?folderPath=Reminders', { headers: { 'If-None-Match': etag(6) } })).rejects.toThrow('repeated a file');
	expect(fetch).toHaveBeenCalledOnce();
});

it('retains bounded retries when the snapshot changes between pages', async () => {
	const fetch = vi.fn();
	for (let attempt = 0; attempt < 3; attempt++) fetch.mockResolvedValueOnce(Response.json(page(7, 'A'))).mockResolvedValueOnce(Response.json(page(8)));
	await expect(client(fetch).handle('/reminders/list?folderPath=Reminders')).rejects.toThrow('changed while loading');
	expect(fetch).toHaveBeenCalledTimes(6);
});

it('publishes decrypted cache entries only after the complete load succeeds', async () => {
	const original = await note('Reminders/Inbox.md', '- [ ] Original <!-- crate-id:task -->\n');
	const changed = await note('Reminders/Inbox.md', '- [ ] Changed <!-- crate-id:task -->\n');
	const fake = server([original]);
	const api = client(fake.fetch);
	await list(api);
	// The changed note downloads, but the batch answer is malformed, so nothing is published.
	fake.set([changed]);
	fake.downloads.set(changed.wire, { content: 5 });
	await expect(list(api)).rejects.toThrow('Invalid encrypted note download');
	fake.set([original]);
	fake.fetch.mockClear();
	expect((await list(api)).body).toMatchObject({ reminders: [{ content: 'Original' }] });
	expect(routes(fake.fetch)).toEqual(['inventory']);
	fake.set([changed]);
	fake.fetch.mockClear();
	expect((await list(api)).body).toMatchObject({ reminders: [{ content: 'Changed' }] });
	expect(routes(fake.fetch)).toEqual(['inventory', 'download']);
});

it('downloads only changed notes after a restart', async () => {
	const inbox = await note('Reminders/Inbox.md', '- [ ] Inbox task <!-- crate-id:inbox -->\n');
	const work = await note('Reminders/Work.md', '- [ ] Work task <!-- crate-id:work -->\n');
	const fake = server([inbox, work]);
	await list(client(fake.fetch));
	fake.set([inbox, await note('Reminders/Work.md', '- [ ] Edited work task <!-- crate-id:work -->\n')]);
	fake.fetch.mockClear();
	const { body } = await list(client(fake.fetch));
	expect(body!.reminders.map(reminder => reminder.content).sort()).toEqual(['Edited work task', 'Inbox task']);
	expect(routes(fake.fetch)).toEqual(['inventory', 'download']);
	expect((JSON.parse(fake.fetch.mock.calls[1]![1]!.body as string) as { files: unknown[] }).files).toHaveLength(1);
});

it('reseals the persisted index only after the listed notes change', async () => {
	const inbox = await note('Reminders/Inbox.md', '- [ ] Inbox task <!-- crate-id:inbox -->\n');
	const fake = server([inbox]);
	const saves = vi.mocked(store.saveIndex).mock.calls.length;
	await list(client(fake.fetch));
	expect(vi.mocked(store.saveIndex).mock.calls.length).toBe(saves + 1);
	// A restart reuses the saved index; changes elsewhere in the vault rewrite nothing.
	const restarted = client(fake.fetch);
	for (let change = 0; change < 2; change++) { fake.set([inbox]); await list(restarted); }
	expect(vi.mocked(store.saveIndex).mock.calls.length).toBe(saves + 1);
	fake.set([await note('Reminders/Inbox.md', '- [ ] Edited inbox task <!-- crate-id:inbox -->\n')]);
	await list(restarted);
	expect(vi.mocked(store.saveIndex).mock.calls.length).toBe(saves + 2);
});

it('commits a semantic revision to the listed note sealed with the vault key', async () => {
	const text = '- [ ] Queued task <!-- crate-id:task -->\n';
	const authority = { vaultId: keys.vaultId, scopeId: 'vault', key: keys.vault };
	const live = await note('Reminders/Inbox.md', text);
	const fake = server([live]);
	const commits: Array<{ files: Array<{ path: string; content: string }> }> = [];
	const fetch = async (path: string, init?: RequestInit) => {
		if (isInventory(path) || isDownload(path)) return fake.fetch(path, init);
		if (path.startsWith('/reminders/encrypted-receipt?')) return Response.json({ envelope: null });
		const body = JSON.parse(init!.body as string) as { acknowledgment: string; files: Array<{ path: string; content: string }> }; commits.push(body);
		return Response.json({ encrypted: body.acknowledgment });
	};
	const api = client(fetch);
	const original = await (await api.handle('/reminders/list?folderPath=Reminders'))!.json() as { reminders: ReminderRecord[] };
	const reminder = original.reminders[0]!;
	expect(reminder).toBeDefined();
	fake.fetch.mockClear();
	const response = await api.handle('/reminders/set-completed', { method: 'POST', body: JSON.stringify({
		operationId: crypto.randomUUID(), folderPath: 'Reminders', id: reminder.id, filePath: reminder.filePath,
		expectedRevision: reminder.revision, completed: true, completedAt: '2026-11-22T10:15:00.000Z',
	}) });
	expect(response!.status).toBe(200);
	// The change checks the kept inventory with one conditional request and reads the cached note.
	expect(routes(fake.fetch)).toEqual(['inventory']);
	expect((await response!.json() as { reminder: ReminderRecord }).reminder.filePath).toBe(live.path);
	expect(commits).toHaveLength(1);
	// The server receives the tagged path; the note itself keeps its plaintext path.
	expect(commits[0]!.files[0]!.path).toBe(live.wire);
	const opened = await openFile(new TextEncoder().encode(commits[0]!.files[0]!.content), live.path, authority);
	expect(new TextDecoder().decode(opened.content)).toContain('- [x] Queued task');
	// The acknowledged attempt keeps no sealed note bytes for its retry window.
	const saved = [...attempts.values()] as Array<{ body: string; acknowledgment?: string }>;
	expect(saved.map(attempt => [attempt.body, typeof attempt.acknowledgment])).toEqual([['', 'string']]);
});

it('downloads only changed notes even when the folder exceeds the content cache', async () => {
	const count = 1050;
	const notes = await Promise.all(Array.from({ length: count }, (_, index) => note(`Reminders/N${String(index).padStart(4, '0')}.md`, `- [ ] Task ${index} <!-- crate-id:t${index} -->\n`)));
	const sorted = () => [...notes].sort((a, b) => a.wire.localeCompare(b.wire));
	let snapshot = 7;
	const fake = server();
	const fetch = vi.fn(async (route: string, init?: RequestInit) => {
		if (isDownload(route)) { fake.set(notes); return fake.fetch(route, init); }
		const after = new URL(route, 'https://x').searchParams.get('after') ?? '';
		const files = sorted().filter(value => value.wire > after).slice(0, 1000);
		return Response.json({ ...page(snapshot, files.length === 1000 ? files.at(-1)!.wire : null), files: files.map(entry) });
	});
	const api = client(fetch);
	expect((await list(api)).body!.reminders).toHaveLength(count);
	notes[0] = await note(notes[0]!.path, '- [x] Task 0 <!-- crate-id:t0 -->\n');
	snapshot = 8;
	fetch.mockClear();
	const refreshed = (await list(api)).body!;
	expect(refreshed.reminders.find(reminder => reminder.id === 't0')?.completed).toBe(true);
	const downloads = fetch.mock.calls.filter(([route]) => isDownload(route));
	expect(downloads.map(([, init]) => (JSON.parse(init!.body as string) as { files: unknown[] }).files.length)).toEqual([1]);
}, 60_000);

it('leaves page-title lookups to the server, which reads the link without storing it', async () => {
	const fetch = vi.fn();
	expect(await client(fetch).handle('/links/title', { method: 'POST', body: JSON.stringify({ url: 'https://private.example' }) })).toBeNull();
	expect(fetch).not.toHaveBeenCalled();
});

const operationId = 'e1_20261020_00000000-0000-4000-8000-000000000001';
const updateBody = () => JSON.stringify({ folderPath: 'Reminders', operationId, id: 'one', content: 'Task', project: 'Inbox' });
const semanticHash = async (action: string, body: string) => sha256Hex(new TextEncoder().encode(JSON.stringify([action, body])).buffer);

it('rejects encrypted changes for another folder or with an invalid operation id before any request', async () => {
	const fetch = vi.fn();
	const api = client(fetch);
	for (const body of [{ folderPath: 'Other', operationId }, { folderPath: 'Reminders', operationId: 'short' }]) {
		const response = await api.handle('/reminders/update', { method: 'POST', body: JSON.stringify(body) });
		expect(response?.status).toBe(400);
		expect(await response?.json()).toMatchObject({ code: 'invalid_reminder_input' });
	}
	expect(await api.handle('/reminders/unknown', { method: 'POST', body: '{}' })).toBeNull();
	expect(fetch).not.toHaveBeenCalled();
});

it('rejects a title that would hide the reminder as invalid input without saving an attempt', async () => {
	const fetch = vi.fn(async (path: string) => path.startsWith('/reminders/encrypted-receipt?') ? Response.json({ envelope: null }) : Response.json(page(1)));
	const response = await client(fetch).handle('/reminders/create', { method: 'POST',
		body: JSON.stringify({ folderPath: 'Reminders', operationId, id: operationId, content: '!', project: 'Inbox' }) });
	expect(response?.status).toBe(400);
	expect(await response?.json()).toMatchObject({ code: 'invalid_reminder_input' });
	expect(attempts.size).toBe(0);
	expect(fetch.mock.calls.some(([path]) => path === '/reminders/encrypted-commit')).toBe(false);
});

it('keeps an unresolved encrypted save from being replaced by different content', async () => {
	attempts.set(`${keys.vaultId}:vault:${operationId}`, { semanticHash: 'different', generation: keys.generation, body: '{}' });
	const fetch = vi.fn();
	await expect(client(fetch).handle('/reminders/update', { method: 'POST', body: updateBody() }))
		.rejects.toThrow('original encrypted save is still unresolved');
	expect(fetch).not.toHaveBeenCalled();
});

it('answers a retried save from its encrypted acknowledgment without contacting the server', async () => {
	const body = updateBody();
	const acknowledgment = await encryptJson({ reminder: { id: 'one' } }, keys.vault, { vaultId: keys.vaultId, scopeId: 'vault', objectId: operationId, purpose: 'reminder' });
	attempts.set(`${keys.vaultId}:vault:${operationId}`, { semanticHash: await semanticHash('update', body), generation: keys.generation, body: '{}', acknowledgment });
	const fetch = vi.fn();
	const response = await client(fetch).handle('/reminders/update', { method: 'POST', body });
	expect(await response?.json()).toEqual({ reminder: { id: 'one' } });
	expect(fetch).not.toHaveBeenCalled();
});
