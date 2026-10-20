/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../../schema.sql?raw';
import { createVaultKeyBundle, addReminderScope, generateRecoveryCode, sealRecoveryBundle } from '../../../encryption/key-bundle';
import { createEncryptionState } from '../../../encryption/server-state';
import { ENCRYPTED_INVENTORY_PAGE } from '../../../encryption/file-inventory';
import { portablePathKey } from '../../../protocol/portable-path';
import { ENCRYPTION_STATE_KEY } from './state';
import { handleEncryptedFolderFiles } from './encrypted-folder-files';
import { meterD1Usage } from '../d1-usage';

const FILES = 2500;

beforeEach(async () => { for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { await reset(); });

async function seed(): Promise<string[]> {
	const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
	const state = createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode()));
	state.mode = 'active';
	await env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)').bind(ENCRYPTION_STATE_KEY, JSON.stringify(state)).run();
	// Mixed case makes original-path order differ from the stored key order.
	const paths = Array.from({ length: FILES }, (_, i) => `Reminders/${i % 2 ? 'note' : 'Note'}-${String(i).padStart(4, '0')}.md`);
	const rows = [...paths, 'Reminders/attachment.png', 'Private/Other.md'];
	const insert = env.DB.prepare('INSERT INTO files(path, portable_path, hash, size, storage_key) VALUES (?, ?, ?, ?, ?)');
	for (let i = 0; i < rows.length; i += 100) {
		await env.DB.batch(rows.slice(i, i + 100).map((path, j) => insert.bind(path, portablePathKey(path), 'a'.repeat(64), 1, `key-${i + j}`)));
	}
	return paths;
}

async function page(after?: string) {
	const meter = meterD1Usage(env.DB);
	const query = new URLSearchParams({ folderPath: 'Reminders', ...(after ? { after } : {}) });
	const response = await handleEncryptedFolderFiles(new Request(`https://test/reminders/encrypted-files?${query}`), { ...env, DB: meter.db }, '/reminders/encrypted-files');
	const body = await response!.json() as { files: Array<{ path: string }>; nextCursor: string | null };
	return { ...body, rowsRead: meter.usage.rowsRead };
}

it('pages a folder by reading only each page of rows', async () => {
	const paths = await seed();
	const seen: string[] = [];
	const reads: number[] = [];
	let cursor: string | undefined;
	do {
		const result = await page(cursor);
		seen.push(...result.files.map(file => file.path));
		reads.push(result.rowsRead);
		if (result.nextCursor !== null && cursor !== undefined) expect(result.nextCursor > cursor).toBe(true);
		cursor = result.nextCursor ?? undefined;
	} while (cursor);

	expect(seen.sort()).toEqual([...paths].sort());
	expect(reads).toHaveLength(Math.ceil(FILES / ENCRYPTED_INVENTORY_PAGE));
	// Before: every page read the whole folder (about 2,500 rows) to sort it.
	for (const rowsRead of reads) expect(rowsRead).toBeLessThanOrEqual(ENCRYPTED_INVENTORY_PAGE + 10);
});

it('resumes an original-case path cursor from an older server after its file', async () => {
	const paths = await seed();
	const after = paths[1000]!;
	const result = await page(after);
	const byKey = (a: string, b: string) => portablePathKey(a) < portablePathKey(b) ? -1 : 1;
	const expected = paths.filter(path => portablePathKey(path) > portablePathKey(after)).sort(byKey).slice(0, 5);
	expect(result.files.map(file => file.path).slice(0, 5)).toEqual(expected);
	expect(result.files.map(file => file.path)).not.toContain(after);
});
