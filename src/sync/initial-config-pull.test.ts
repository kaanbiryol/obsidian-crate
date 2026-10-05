import { expect, it, vi } from 'vitest';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '../cloudflare/worker/sync-engine-vault-test-harness';
import type { FileEntry } from '../protocol/sync-types';
import { LocalManifest } from './manifest';
import { computeHash } from './hasher';
import { createFullSyncPlan } from './planner-full';
import { parseInitialConfigPull } from './initial-config-pull';

const settingsPath = '.obsidian/appearance.json';
const local = '{"cssTheme":""}';
const remote = '{"cssTheme":"Minimal"}';
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const entry = async (text: string): Promise<FileEntry> => ({ hash: await computeHash(bytes(text)), size: bytes(text).byteLength, modified: '2026-10-01T00:00:00Z', revision: '1' });

async function fixture() {
	const disk = new PersistentTestVault();
	disk.write(settingsPath, local);
	const createManifest = () => new LocalManifest({ vault: disk.vault } as never, { dir: TEST_PLUGIN_DIR } as never, 'server');
	let manifest = createManifest();
	const remoteFiles = { [settingsPath]: await entry(remote), 'note.md': await entry('remote note') };
	const context = {
		vault: disk.vault,
		get localManifest() { return manifest; },
		throwIfDestroyed: () => {}, shouldIgnore: (path: string) => path.startsWith(`${TEST_PLUGIN_DIR}/`) || path === TEST_PLUGIN_DIR,
		runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
		initialConfigPull: {
			firstSync: true,
			get: () => manifest.getInitialConfigPull(),
			save: async (state: NonNullable<ReturnType<LocalManifest['getInitialConfigPull']>>) => { manifest.setInitialConfigPull(state); await manifest.save(); },
		},
	};
	return { disk, context, remoteFiles, plan: () => createFullSyncPlan(context, remoteFiles, 2),
		reopen: async () => { manifest = createManifest(); await manifest.load(); } };
}

it('downloads existing server settings into an empty vault with BRAT and Crate installed', async () => {
	const h = await fixture();
	await h.disk.vault.adapter.mkdir('.obsidian/plugins/obsidian42-brat');
	h.disk.write('.obsidian/plugins/obsidian42-brat/data.json', '{}');
	h.disk.write(`${TEST_PLUGIN_DIR}/data.json`, '{}');
	const plan = await h.plan();
	expect(plan.downloadDiffs.map(diff => diff.path)).toEqual([settingsPath, 'note.md']);
	expect(plan.remainingDiffs).toEqual([]);
	expect(plan.uploadDiffs.some(diff => diff.path === settingsPath)).toBe(false);
	// This is replacement intent, never a fabricated last-synced baseline.
	expect(h.context.localManifest.getEntry(settingsPath)).toBeUndefined();
	await h.reopen();
	expect(h.context.localManifest.getInitialConfigPull()).toEqual({ configDir: '.obsidian', files: { [settingsPath]: await computeHash(bytes(local)) } });
});

it.each(['note.md', '.other-settings.json'])('keeps normal conflicts when the new device already has %s', async path => {
	const h = await fixture();
	h.disk.write(path, 'existing user data');
	expect((await h.plan()).remainingDiffs).toContainEqual(expect.objectContaining({ path: settingsPath, action: 'conflict' }));
	expect(h.context.localManifest.getInitialConfigPull()).toBeUndefined();
});

it.each(['previous sync', 'existing checkpoint'] as const)('does not treat %s as a new empty vault', async reason => {
	const h = await fixture();
	if (reason === 'previous sync') h.context.initialConfigPull.firstSync = false;
	else h.context.localManifest.setEntry('removed-note.md', await entry('previously synced'));
	expect((await h.plan()).remainingDiffs).toContainEqual(expect.objectContaining({ path: settingsPath, action: 'conflict' }));
});

it('uploads the first device normally when the server is empty', async () => {
	const h = await fixture();
	const plan = await createFullSyncPlan(h.context, {}, 2);
	expect(plan.uploadDiffs.map(diff => diff.path)).toEqual([settingsPath]);
	expect(h.context.localManifest.getInitialConfigPull()).toBeUndefined();
});

it.each([false, true])('resumes a partial pull after restart while preserving a new settings edit: %s', async edited => {
	const h = await fixture();
	await h.plan();
	h.disk.write('note.md', 'remote note');
	h.context.localManifest.setEntry('note.md', h.remoteFiles['note.md']);
	await h.context.localManifest.save();
	await h.reopen();
	if (edited) h.disk.write(settingsPath, '{"cssTheme":"new choice"}');
	const plan = await h.plan();
	expect(plan.diffs.find(diff => diff.path === settingsPath)?.action).toBe(edited ? 'conflict' : 'download');
});

it('keeps ordinary conflict handling once a settings file has a common baseline', async () => {
	const h = await fixture();
	await h.plan();
	h.context.localManifest.setEntry(settingsPath, await entry('common settings'));
	expect((await h.plan()).remainingDiffs).toContainEqual(expect.objectContaining({ path: settingsPath, action: 'conflict', cause: 'concurrent-edit' }));
});

it('stops planning when the setup snapshot cannot be saved', async () => {
	const h = await fixture();
	vi.spyOn(h.disk.vault.adapter, 'write').mockRejectedValue(new Error('disk full'));
	await expect(h.plan()).rejects.toThrow('disk full');
	expect(h.disk.text(settingsPath)).toBe(local);
	expect(h.context.localManifest.getEntry(settingsPath)).toBeUndefined();
});

it('uses the active custom configuration directory', async () => {
	const h = await fixture();
	h.disk.remove(settingsPath);
	h.disk.vault.configDir = 'custom-settings';
	await h.disk.vault.adapter.mkdir('custom-settings');
	h.disk.write('custom-settings/appearance.json', local);
	const plan = await createFullSyncPlan(h.context, { 'custom-settings/appearance.json': await entry(remote) }, 2);
	expect(plan.downloadDiffs.map(diff => diff.path)).toEqual(['custom-settings/appearance.json']);
	expect(plan.remainingDiffs).toEqual([]);
});

it.each([null, {}, { configDir: '../outside', files: {} }, { configDir: '.obsidian', files: { 'note.md': 'a'.repeat(64) } },
	{ configDir: '.obsidian', files: { [settingsPath]: 'invalid' } }])('rejects malformed initial pull authority: %j', value => {
	expect(() => parseInitialConfigPull(value)).toThrow('Invalid initial settings pull checkpoint');
});
