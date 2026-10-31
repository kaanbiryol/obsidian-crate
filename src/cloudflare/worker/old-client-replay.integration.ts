/// <reference types="@cloudflare/vitest-plugin/types" />
/**
 * Replays the requests a released client sends through the real Worker, D1, R2
 * and Durable Objects, and checks each response against what that client
 * expects. The expectations are written out here on purpose instead of calling
 * today's client parsers, so a change to both sides cannot pass unnoticed.
 *
 * Recorded clients live in `__fixtures__/` and are append-only. When a protocol or
 * capability set is released, record its requests in a new file (for example
 * `protocol-2-client.json`), import it below and append it to `clients`. Keep
 * every older file while servers still accept that protocol; never edit one.
 * A missing file fails the import, so this suite cannot run without it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from './test-support/schema-test-harness';
import worker from './index';
import { sha256Hex } from '../../platform/sha256';
import protocol1 from './__fixtures__/protocol-1-client.json';

interface RecordedRequest { method: string; path: string; headers: Record<string, string>; body?: string }
interface RecordedClient {
	protocolHeader: string;
	clientProtocol: { current: number; oldestCompatible: number };
	requiredCapabilities: string[];
	requests: Record<'serverInfo' | 'upload' | 'batchUpload' | 'manifest' | 'changes' | 'check' | 'metadata' | 'download' | 'reminderCreate' | 'reminderList', RecordedRequest>;
}

const clients: Array<[string, RecordedClient]> = [['protocol 1 (0.9.0)', protocol1]];
const token = 'old-client-replay-test-credential';
const sha256 = /^[a-f0-9]{64}$/;

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare('INSERT INTO auth_tokens (id, token_hash, scope) VALUES (?, ?, ?)')
		.bind('old-client', await sha256Hex(new TextEncoder().encode(token)), 'vault').run();
});
afterEach(async () => { await reset(); });

/** The released client's view of a manifest or metadata entry. */
function expectFileEntry(entry: unknown, content: string, hash: string) {
	expect(entry).toMatchObject({ hash, size: new TextEncoder().encode(content).byteLength, modified: expect.any(String) as string, revision: expect.any(String) as string });
	const { modified } = entry as { modified: string };
	expect(modified).toMatch(/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/);
}

describe.each(clients)('recorded %s client against the current Worker', (_name, client) => {
	let day = '';
	const send = async (recorded: RecordedRequest) => {
		const fill = (text: string) => text.replaceAll('{{operationDay}}', day);
		const headers = Object.fromEntries(Object.entries(recorded.headers).map(([name, value]) => [name, fill(value)]));
		return worker.fetch(new Request(`https://old-client.test${recorded.path}`, {
			method: recorded.method,
			...(recorded.body === undefined ? {} : { body: fill(recorded.body) }),
			headers: { ...headers, Authorization: `Bearer ${token}`, 'X-Crate-Protocol': client.protocolHeader },
		}), env);
	};
	const json = async (recorded: RecordedRequest) => {
		const response = await send(recorded);
		const text = await response.text();
		expect(response.status, text).toBe(200);
		return JSON.parse(text) as Record<string, unknown>;
	};
	const changelogRows = async () => (await env.DB.prepare('SELECT COUNT(*) AS count FROM changelog').first<{ count: number }>())!.count;

	async function handshake() {
		const info = await json(client.requests.serverInfo);
		expect(info).toMatchObject({ service: 'crate', serverVersion: expect.any(String) as string });
		const protocol = info.protocol as { current: number; oldestCompatible: number };
		// The client's own range check: each side's oldest version must be at most the other's current.
		expect(protocol.oldestCompatible).toBeLessThanOrEqual(client.clientProtocol.current);
		expect(client.clientProtocol.oldestCompatible).toBeLessThanOrEqual(protocol.current);
		expect(info.capabilities).toEqual(expect.arrayContaining(client.requiredCapabilities));
		expect(Number.isSafeInteger(info.reminderOperationDay) && (info.reminderOperationDay as number) > 0).toBe(true);
		day = String(info.reminderOperationDay).padStart(8, '0');
	}

	it('completes the handshake the client checks before writing', async () => {
		await handshake();
	});

	it('uploads, retries after a lost response, and reads the same state back', async () => {
		await handshake();
		const upload = client.requests.upload;
		const uploaded = await json(upload);
		expect(uploaded).toMatchObject({ success: true, path: 'Notes/hello.md', hash: upload.headers['X-File-Hash'], revision: expect.any(String) as string });
		// The same request after a lost response returns the original receipt without a new commit.
		expect(await json(upload)).toEqual(uploaded);
		expect(await changelogRows()).toBe(1);

		const batch = await json(client.requests.batchUpload);
		expect(batch).toMatchObject({ success: true, results: [{ path: 'b.md', success: true, hash: '320b5d80f8cfd184c57473d7081003135e0001480dac18583a0bdc748b361b88', revision: expect.any(String) as string }] });
		expect(await json(client.requests.batchUpload)).toEqual(batch);
		expect(await changelogRows()).toBe(2);
		const batchRevision = (batch.results as Array<{ revision: string }>)[0]!.revision;

		const manifest = await json(client.requests.manifest);
		expect(manifest).toMatchObject({ version: 1, lastSeq: 2, snapshotSeq: 2, hasMore: false });
		expect(manifest.nextCursor).toBeUndefined();
		expect(manifest.truncated === undefined || manifest.truncated === false).toBe(true);
		const files = manifest.files as Record<string, { revision: string }>;
		expect(Object.keys(files).sort()).toEqual(['Notes/hello.md', 'b.md']);
		expectFileEntry(files['Notes/hello.md'], upload.body!, upload.headers['X-File-Hash']!);
		expectFileEntry(files['b.md'], 'Batch', '320b5d80f8cfd184c57473d7081003135e0001480dac18583a0bdc748b361b88');
		expect(files['Notes/hello.md']!.revision).toBe(uploaded.revision);
		expect(files['b.md']!.revision).toBe(batchRevision);

		const changes = await json(client.requests.changes);
		expect(changes).toMatchObject({ lastSeq: 2, hasMore: false });
		expect(changes.cursorExpired === undefined || changes.cursorExpired === false).toBe(true);
		expect(changes.changes).toEqual([
			expect.objectContaining({ seq: 1, path: 'Notes/hello.md', action: 'put', hash: uploaded.hash, size: 21, revision: uploaded.revision, created_at: expect.any(String) as string }),
			expect.objectContaining({ seq: 2, path: 'b.md', action: 'put', size: 5, revision: batchRevision, created_at: expect.any(String) as string }),
		]);
		expect(await json(client.requests.check)).toMatchObject({ lastSeq: 2, hasChanges: true });

		// Absent paths are omitted; the client rejects any path it did not ask for.
		const metadata = await json(client.requests.metadata);
		expect(Object.keys(metadata.files as object)).toEqual(['b.md']);
		expectFileEntry((metadata.files as Record<string, unknown>)['b.md'], 'Batch', '320b5d80f8cfd184c57473d7081003135e0001480dac18583a0bdc748b361b88');

		const download = await send(client.requests.download);
		expect(download.status).toBe(200);
		expect(await download.text()).toBe(upload.body);
		expect(download.headers.get('X-File-Hash')).toBe(uploaded.hash);
		expect(download.headers.get('X-Crate-Revision')).toBe(uploaded.revision);
		expect(download.headers.get('Content-Length')).toBe('21');
	});

	it('creates a reminder, retries it after a lost response, and lists it', async () => {
		await handshake();
		const request = client.requests.reminderCreate;
		const id = (JSON.parse(request.body!.replaceAll('{{operationDay}}', day)) as { id: string }).id;
		const created = await json(request);
		expect(created).toMatchObject({ success: true, reminder: {
			id, content: 'Water the plants', description: 'Synthetic note', project: 'Inbox', priority: 4, completed: false,
			dueDatetime: '2099-01-02T08:30:00.000Z', filePath: 'Reminders/Inbox.md', revision: expect.stringMatching(sha256) as string,
		} });
		const receipts = await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_operations').first<{ count: number }>();
		const commits = await changelogRows();
		expect(await json(request)).toEqual(created);
		expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_operations').first()).toEqual(receipts);
		expect(await changelogRows()).toBe(commits);

		const list = await json(client.requests.reminderList);
		expect(list.reminders).toEqual([expect.objectContaining({ id, content: 'Water the plants', revision: (created.reminder as { revision: string }).revision })]);
		expect(list.projects).toEqual(['Inbox']);
		expect(list.issues).toEqual([]);
	});
});
