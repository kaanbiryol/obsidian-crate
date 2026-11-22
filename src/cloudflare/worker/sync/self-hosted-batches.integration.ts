/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { SyncTestDevice } from '../test-support/sync-engine-test-harness';
import { SELF_HOSTED_BATCH_LIMITS } from '../../../protocol/sync-limits';

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

async function device(id: string): Promise<SyncTestDevice> {
	const result = new SyncTestDevice(id, env);
	devices.push(result);
	await result.authorize();
	await result.open();
	return result;
}
const count = (device: SyncTestDevice, route: string) => device.requests.filter(request => request === route).length;

it('moves files in the self-hosted server\'s larger batches, within its query budget', { timeout: 120_000 }, async () => {
	const { uploadFiles, deleteFiles, downloadFiles } = SELF_HOSTED_BATCH_LIMITS;
	const first = await device('batches-first');
	// The first sync imports the vault; edits afterwards travel as ordinary batches.
	const paths = Array.from({ length: uploadFiles + 10 }, (_, index) => `note-${index}.md`);
	for (const path of paths) first.disk.write(path, 'original');
	expect((await first.engine.sync()).success).toBe(true);
	for (const path of paths) { first.disk.write(path, `edited ${path}`); first.engine.onFileChange({ path } as never); }
	first.requests.length = 0;
	expect(await first.engine.sync()).toMatchObject({ success: true, uploaded: paths.length, errors: [] });
	expect(count(first, 'POST /sync/batch-upload')).toBeLessThanOrEqual(Math.ceil(paths.length / uploadFiles) + 1);

	const second = await device('batches-second');
	second.requests.length = 0;
	expect(await second.engine.sync()).toMatchObject({ success: true, downloaded: paths.length, errors: [] });
	expect(count(second, 'POST /sync/batch-download')).toBe(Math.ceil(paths.length / downloadFiles));

	for (const path of paths) { await first.disk.vault.adapter.remove(path); first.engine.onFileDelete({ path } as never); }
	first.requests.length = 0;
	expect(await first.engine.sync()).toMatchObject({ success: true, deleted: paths.length, errors: [] });
	expect(count(first, 'POST /sync/batch-delete')).toBe(Math.ceil(paths.length / deleteFiles));
	expect(Object.keys((await first.api.getManifest()).files)).toEqual([]);
});
