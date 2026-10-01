/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schemaSql from '../schema.sql?raw';
import { SyncTestDevice } from './sync-engine-test-harness';
import { TEST_PLUGIN_DIR } from './sync-engine-vault-test-harness';

const paths = ['app', 'appearance', 'community-plugins', 'core-plugins'].map(name => `.obsidian/${name}.json`);
const appearance = '.obsidian/appearance.json';
const remoteText = '{"setting":"from a"}';
const setupText = '{"setting":"new vault default"}';
const devices: SyncTestDevice[] = [];

beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	for (const sql of schemaSql.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});

afterEach(async () => {
	for (const device of devices.splice(0)) device.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	await reset();
});

async function device(id: string) {
	const result = new SyncTestDevice(id, env);
	devices.push(result);
	await result.authorize();
	await result.open();
	return result;
}

async function setup() {
	const first = await device('first');
	for (const path of paths) first.disk.write(path, remoteText);
	first.disk.write('note.md', 'vault from a');
	await first.disk.vault.adapter.mkdir('.obsidian/themes/Minimal');
	first.disk.write('.obsidian/themes/Minimal/theme.css', 'body { color: red; }');
	expect((await first.engine.sync()).errors).toEqual([]);
	const second = await device('second');
	for (const path of paths) {
		second.disk.write(path, setupText);
		await second.engine.onRawFileChange(path);
	}
	return { first, second };
}

it('pulls server settings without setup conflicts, then preserves real concurrent settings edits', async () => {
	const { first, second } = await setup();
	const before = await first.api.getManifest();
	const pulled = await second.engine.sync();
	expect(pulled.errors).toEqual([]);
	expect(pulled.conflicts).toEqual([]);
	expect(pulled.uploaded).toBe(0);
	expect(second.engine.getPendingPaths()).toEqual([]);
	expect(second.engine.getActiveConflicts()).toEqual([]);
	for (const path of paths) expect(second.disk.text(path)).toBe(remoteText);
	expect(second.disk.text('note.md')).toBe('vault from a');
	expect(second.disk.text('.obsidian/themes/Minimal/theme.css')).toBe('body { color: red; }');
	expect((await first.api.getManifest()).files).toEqual(before.files);
	expect(JSON.parse(second.disk.text(`${TEST_PLUGIN_DIR}/file-manifest.json`))).not.toHaveProperty('initialConfigPull');

	first.disk.write(appearance, '{"setting":"a edited"}');
	second.disk.write(appearance, '{"setting":"b edited"}');
	expect((await first.engine.sync()).errors).toEqual([]);
	const conflicted = await second.engine.sync();
	expect(conflicted.errors).toEqual([]);
	expect(conflicted.unresolvedConflicts).toHaveLength(1);
	expect(second.disk.text(appearance)).toBe('{"setting":"a edited"}');
	expect(second.disk.text(conflicted.unresolvedConflicts[0]!.conflictPath)).toBe('{"setting":"b edited"}');
});

it.each([false, true])('resumes a partial first pull after restart without overwriting a newer local edit: %s', async edited => {
	const { second } = await setup();
	const batchDownload = second.api.batchDownload.bind(second.api);
	vi.spyOn(second.api, 'batchDownload').mockImplementationOnce(async requested => {
		const response = await batchDownload(requested);
		return { files: response.files.map(file => file.path === appearance ? { ...file, error: 'interrupted download' } : file) };
	});
	const interrupted = await second.engine.sync();
	expect(interrupted.success).toBe(false);
	expect(second.disk.text('note.md')).toBe('vault from a');
	expect(second.disk.text(appearance)).toBe(setupText);
	expect(second.settings.lastSync).toBeNull();
	expect(JSON.parse(second.disk.text(`${TEST_PLUGIN_DIR}/file-manifest.json`))).toHaveProperty('initialConfigPull');
	second.close();
	await second.open();
	if (edited) second.disk.write(appearance, '{"setting":"edited after interruption"}');
	const resumed = await second.engine.sync();
	expect(resumed.errors).toEqual([]);
	expect(resumed.unresolvedConflicts).toHaveLength(edited ? 1 : 0);
	expect(second.disk.text(appearance)).toBe(remoteText);
	if (edited) expect(second.disk.text(resumed.unresolvedConflicts[0]!.conflictPath)).toBe('{"setting":"edited after interruption"}');
	expect(JSON.parse(second.disk.text(`${TEST_PLUGIN_DIR}/file-manifest.json`))).not.toHaveProperty('initialConfigPull');
});

it('defers an initial settings replacement when the user edits during download', async () => {
	const { second } = await setup();
	const batchDownload = second.api.batchDownload.bind(second.api);
	vi.spyOn(second.api, 'batchDownload').mockImplementationOnce(async requested => {
		const response = await batchDownload(requested);
		second.disk.write(appearance, '{"setting":"edited while downloading"}');
		return response;
	});
	const result = await second.engine.sync();
	expect(result.success).toBe(false);
	expect(second.disk.text(appearance)).toBe('{"setting":"edited while downloading"}');
	expect(result.errors.some(error => error.includes(appearance))).toBe(true);
});
