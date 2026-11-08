/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { SyncTestDevice } from '../test-support/sync-engine-test-harness';

const devices: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	await applySchema(env.DB);
});
afterEach(async () => {
	for (const device of devices.splice(0)) device.close();
	vi.unstubAllGlobals();
	await reset();
});

/** Saves every D1 row except credentials, as a server backup does, and returns its restore.
 * R2 still holds every object a restored row names: replaced versions are retained. */
async function backupServer(): Promise<() => Promise<void>> {
	const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
		AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'auth_tokens'`).all<{ name: string }>();
	const tables = await Promise.all(results.map(async ({ name }) => ({
		name, rows: (await env.DB.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>()).results,
	})));
	return async () => {
		await env.DB.batch(tables.flatMap(({ name, rows }) => [
			env.DB.prepare(`DELETE FROM "${name}"`),
			...rows.map(row => env.DB.prepare(`INSERT INTO "${name}" (${Object.keys(row).map(column => `"${column}"`).join(', ')})
				VALUES (${Object.keys(row).map(() => '?').join(', ')})`).bind(...Object.values(row))),
		]));
	};
}

async function sync(device: SyncTestDevice) {
	const result = await device.engine.sync();
	expect(result.errors, `${device.id}: ${JSON.stringify(result)}`).toEqual([]);
	expect(result.success).toBe(true);
	return result;
}

it('merges with a server restored from an older backup instead of rolling this device back', async () => {
	const device = new SyncTestDevice('restored-device', env);
	devices.push(device);
	await device.authorize();
	await device.open();
	device.disk.write('F.md', 'v1\n');
	await sync(device);
	const restoreBackup = await backupServer();
	device.disk.write('F.md', 'v2\n');
	device.disk.write('G.md', 'created after the backup\n');
	await sync(device);
	// The next sync, or the periodic check, reads this device's own uploads and moves its cursor past the backup.
	await sync(device);
	const cursor = device.settings.lastSeq;
	expect(cursor).toBe(3);

	device.close();
	await device.engine.waitForIdle();
	await restoreBackup();
	await device.open();
	expect((await device.api.checkForChanges(cursor)).lastSeq).toBeLessThan(cursor);
	await sync(device);

	// The newer edit survives, at F or as its conflict copy, and G is neither trashed nor lost.
	expect(device.disk.paths().filter(path => device.disk.text(path) === 'v2\n')).toHaveLength(1);
	expect(device.disk.text('G.md')).toBe('created after the backup\n');
	expect([...device.disk.trash.keys()]).toEqual([]);
	const remote = await device.api.getManifest();
	expect(Object.keys(remote.files).sort()).toEqual(['F.md', 'G.md']);
	expect(new TextDecoder().decode((await device.api.downloadFile('G.md')).content)).toBe('created after the backup\n');
	expect(device.settings.lastSeq).toBeLessThanOrEqual(remote.lastSeq!);

	// The next sync continues incrementally from the restored server and changes nothing.
	const next = await sync(device);
	expect(next.uploaded + next.downloaded + next.deleted + next.conflicts.length).toBe(0);
	expect(device.disk.text('G.md')).toBe('created after the backup\n');
});
