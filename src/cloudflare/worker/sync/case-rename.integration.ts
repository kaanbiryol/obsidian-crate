/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { SyncTestDevice } from '../test-support/sync-engine-test-harness';
import { pendingChangeKey } from '../../../sync/pending/pending-change';

const devices: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	await applySchema(env.DB);
});
afterEach(async () => { for (const device of devices.splice(0)) device.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });

async function device(id: string, caseInsensitive: boolean): Promise<SyncTestDevice> {
	const created = new SyncTestDevice(id, env, { caseInsensitive }); devices.push(created);
	await created.authorize(); await created.open();
	return created;
}

async function sync(client: SyncTestDevice, full = false) {
	if (full) client.settings.lastSeq = 0;
	const result = await client.engine.sync();
	expect(result.errors, client.id).toEqual([]);
	return result;
}

const serverPaths = async (client: SyncTestDevice) => Object.keys((await client.api.getManifest()).files).sort();
const serverText = async (client: SyncTestDevice, path: string) => new TextDecoder().decode((await client.api.downloadFile(path)).content);

describe.each([['case-insensitive', true], ['case-sensitive', false]] as const)('a case-only rename on a %s disk', (_disk, caseInsensitive) => {
	it.each(['queue', 'selected', 'incremental', 'full', 'force'] as const)('syncs through %s sync and reaches another device', async mode => {
		const renamer = await device(`case-${mode}`, caseInsensitive);
		const receiver = await device(`case-${mode}-receiver`, caseInsensitive);
		renamer.disk.write('todo.md', 'Groceries');
		await sync(renamer);
		await sync(receiver);
		expect(receiver.disk.paths()).toEqual(['todo.md']);

		if (mode === 'queue') {
			renamer.settings.automaticSync = true;
			renamer.settings.debounceDelay = 0;
		}
		renamer.disk.rename('todo.md', 'TODO.md');
		renamer.engine.onFileRename(renamer.disk.vault.getAbstractFileByPath('TODO.md')!, 'todo.md');
		if (mode === 'queue') {
			await vi.waitFor(() => expect(renamer.engine.getPendingKeys()).toEqual([]));
			await renamer.engine.waitForIdle();
			expect(renamer.engine.getState()).toMatchObject({ status: 'idle', lastError: null });
		} else if (mode === 'force') {
			expect((await renamer.engine.forceFullSync()).errors).toEqual([]);
		} else if (mode === 'selected') {
			expect((await renamer.engine.syncSelected([pendingChangeKey('delete', 'todo.md'), 'TODO.md'])).errors).toEqual([]);
		} else {
			await sync(renamer, mode === 'full');
		}

		expect(await serverPaths(renamer)).toEqual(['TODO.md']);
		expect(await serverText(renamer, 'TODO.md')).toBe('Groceries');
		expect(renamer.engine.getPendingKeys()).toEqual([]);
		await sync(renamer);
		expect(renamer.disk.paths()).toEqual(['TODO.md']);

		// The receiving device removes the old name before writing the new one, so a
		// case-insensitive disk keeps the file and neither name returns to the server.
		await sync(receiver, mode === 'full' || mode === 'force');
		expect(receiver.disk.paths()).toEqual(['TODO.md']);
		expect(receiver.disk.text('TODO.md')).toBe('Groceries');
		await sync(receiver);
		await sync(renamer);
		expect(await serverPaths(renamer)).toEqual(['TODO.md']);
		expect(renamer.disk.paths()).toEqual(['TODO.md']);
	});
});

it('deletes an unrelated queued file while a namespace conflict keeps its upload pending', async () => {
	const first = await device('namespace-first', false);
	const second = await device('namespace-second', false);
	first.disk.write('old.md', 'Remove me');
	await sync(first);
	await sync(second);
	second.disk.write('projects.md', 'From the second device');
	await sync(second);

	first.settings.automaticSync = true;
	first.settings.debounceDelay = 0;
	first.disk.write('Projects.md', 'From the first device');
	first.disk.remove('old.md');
	first.engine.onFileChange(first.disk.vault.getAbstractFileByPath('Projects.md')!);
	first.engine.onFileDelete({ path: 'old.md' } as never);
	await vi.waitFor(() => expect(first.engine.getState().status).toBe('error'));
	await first.engine.waitForIdle();

	expect(await serverPaths(first)).toEqual(['projects.md']);
	expect(first.engine.getPendingKeys()).toEqual(['Projects.md']);
	expect(first.engine.getPendingKeys()).not.toContain(pendingChangeKey('delete', 'old.md'));
	expect(first.engine.getState().lastError).toContain('conflicts with "projects.md"');
});
