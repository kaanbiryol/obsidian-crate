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

/** Replaces the server with a new, empty one at the same address. Device credentials stay,
 * as if every device had paired again. */
async function replaceServer(): Promise<void> {
	const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
		AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'auth_tokens'`).all<{ name: string }>();
	await env.DB.batch(results.map(({ name }) => env.DB.prepare(`DELETE FROM "${name}"`)));
}

async function sync(device: SyncTestDevice) {
	const result = await device.engine.sync();
	expect(result.errors, `${device.id}: ${JSON.stringify(result)}`).toEqual([]);
	expect(result.success).toBe(true);
	return result;
}

async function device(id: string) {
	const created = new SyncTestDevice(id, env);
	devices.push(created);
	await created.authorize();
	await created.open();
	return created;
}

it('a device whose cursor a new server at its address has reached merges instead of trashing its notes', async () => {
	const laptop = await device('laptop');
	const phone = await device('phone');
	laptop.disk.write('Shared.md', 'shared\n');
	await sync(laptop);
	await sync(phone);
	// Only the phone and the lost server ever had this note.
	phone.disk.write('Phone only.md', 'written on the phone\n');
	await sync(phone);
	const phoneCursor = phone.settings.lastSeq;
	expect(phone.settings.serverStorageId).toMatch(/^[a-f0-9]{32}$/);

	await replaceServer();
	// The laptop rebuilds the server, then keeps working until the new changelog passes the phone's cursor.
	await sync(laptop);
	for (let edit = 0; (await phone.api.checkForChanges(phoneCursor)).lastSeq < phoneCursor; edit++) {
		laptop.disk.write(`Laptop ${edit}.md`, `edit ${edit}\n`);
		await sync(laptop);
	}
	const check = await phone.api.checkForChanges(phoneCursor);
	expect(check.lastSeq).toBeGreaterThanOrEqual(phoneCursor);
	expect(check.storageId).not.toBe(phone.settings.serverStorageId);

	await sync(phone);
	expect([...phone.disk.trash.keys()]).toEqual([]);
	expect(phone.disk.text('Phone only.md')).toBe('written on the phone\n');
	expect(new TextDecoder().decode((await laptop.api.downloadFile('Phone only.md')).content)).toBe('written on the phone\n');
	expect(phone.settings.serverStorageId).toBe(check.storageId);

	// Once merged, the phone syncs incrementally with the new server and changes nothing.
	const next = await sync(phone);
	expect(next.uploaded + next.downloaded + next.deleted + next.conflicts.length).toBe(0);
});

it('a server reports one storage identity until it is replaced', async () => {
	const laptop = await device('laptop');
	const first = (await laptop.api.checkForChanges(0)).storageId;
	expect(first).toMatch(/^[a-f0-9]{32}$/);
	expect((await laptop.api.checkForChanges(0)).storageId).toBe(first);
	await replaceServer();
	const second = (await laptop.api.checkForChanges(0)).storageId;
	expect(second).toMatch(/^[a-f0-9]{32}$/);
	expect(second).not.toBe(first);
});
