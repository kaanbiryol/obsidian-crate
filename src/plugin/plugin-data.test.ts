import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from 'obsidian';
import { Notice } from '../test/mocks/obsidian';
import { keepLastGoodPluginData, loadPluginData, upgradeLoadedPluginData } from './plugin-data';
import { upgradePluginData } from './plugin-data-version';

const dir = '.obsidian/plugins/crate';
const TORN = '{"workerUrl":"https://crate.exa';

/** An adapter whose renames, like Obsidian's, never replace an existing file. */
function harness(files: Record<string, string> = {}) {
	const disk = new Map(Object.entries(files).map(([name, text]) => [`${dir}/${name}`, text]));
	const adapter = {
		exists: vi.fn(async (path: string) => disk.has(path)),
		read: vi.fn(async (path: string) => {
			const text = disk.get(path);
			if (text === undefined) throw new Error(`Missing ${path}`);
			return text;
		}),
		write: vi.fn(async (path: string, text: string) => { disk.set(path, text); }),
		remove: vi.fn(async (path: string) => { disk.delete(path); }),
		rename: vi.fn(async (from: string, to: string) => {
			if (disk.has(to)) throw new Error('Destination file already exists!');
			disk.set(to, disk.get(from)!); disk.delete(from);
		}),
	};
	const plugin = {
		app: { vault: { adapter } }, manifest: { dir },
		// Obsidian parses data.json without catching, so a torn file throws a SyntaxError.
		loadData: vi.fn(async (): Promise<unknown> => disk.has(`${dir}/data.json`) ? JSON.parse(disk.get(`${dir}/data.json`)!) : null),
		saveData: vi.fn(async (data: unknown) => { disk.set(`${dir}/data.json`, JSON.stringify(data)); }),
	};
	const file = (name: string) => disk.get(`${dir}/${name}`);
	const names = () => [...disk.keys()].map(path => path.slice(dir.length + 1)).sort();
	return { plugin, asPlugin: plugin as unknown as Plugin, adapter, file, names };
}

beforeEach(() => { Notice.reset(); vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000); });

it('loads saved data without touching any file', async () => {
	const h = harness({ 'data.json': '{"workerUrl":"https://crate.example"}' });
	expect(await loadPluginData(h.asPlugin)).toEqual({ workerUrl: 'https://crate.example' });
	expect(h.names()).toEqual(['data.json']);
	expect(Notice.messages).toEqual([]);
});

it('treats a missing data.json as no saved data', async () => {
	const h = harness();
	expect(await loadPluginData(h.asPlugin)).toBeNull();
	expect(h.adapter.rename).not.toHaveBeenCalled();
});

it.each([TORN, '', '[1,2]'])('keeps damaged data %j and restores the last good copy', async damaged => {
	const h = harness({ 'data.json': damaged, 'data.last-good.json': '{"workerUrl":"https://crate.example"}' });
	expect(await loadPluginData(h.asPlugin)).toEqual({ workerUrl: 'https://crate.example' });
	expect(h.file('data.json.corrupt-1700000000000')).toBe(damaged);
	expect(h.plugin.saveData).toHaveBeenCalledExactlyOnceWith({ workerUrl: 'https://crate.example' });
	expect(JSON.parse(h.file('data.json')!)).toEqual({ workerUrl: 'https://crate.example' });
	expect(Notice.messages).toEqual([expect.stringContaining('restored the last good copy')]);
	expect(Notice.messages[0]).toContain('data.json.corrupt-1700000000000');
});

it('keeps damaged data and starts from defaults when there is no good copy', async () => {
	const h = harness({ 'data.json': TORN, 'data.last-good.json': TORN });
	expect(await loadPluginData(h.asPlugin)).toBeNull();
	expect(h.file('data.json.corrupt-1700000000000')).toBe(TORN);
	// The next save writes defaults; until then, a restart also starts from defaults.
	expect(h.file('data.json')).toBeUndefined();
	expect(h.plugin.saveData).not.toHaveBeenCalled();
	expect(Notice.messages).toEqual([expect.stringContaining('started with defaults. Sync is disconnected')]);
});

it('restores the complete copy an interrupted swap left behind', async () => {
	const h = harness({ 'data.json': TORN, 'data.last-good.json.tmp': '{"workerUrl":"https://crate.example"}' });
	expect(await loadPluginData(h.asPlugin)).toEqual({ workerUrl: 'https://crate.example' });
});

it('stops without touching data.json when it cannot be read', async () => {
	const h = harness({ 'data.json': '{}', 'data.last-good.json': '{"workerUrl":"https://crate.example"}' });
	h.plugin.loadData.mockRejectedValueOnce(new Error('Input/output error'));
	await expect(loadPluginData(h.asPlugin)).rejects.toThrow('Input/output error');
	expect(h.names()).toEqual(['data.json', 'data.last-good.json']);
	expect(h.plugin.saveData).not.toHaveBeenCalled();
});

it('writes the good copy only when its content changed, replacing it atomically', async () => {
	const h = harness({ 'data.last-good.json': '{"dataVersion":1,"lastSeq":1}' });
	await keepLastGoodPluginData(h.asPlugin, { lastSeq: 1 });
	expect(h.adapter.write).not.toHaveBeenCalled();
	await keepLastGoodPluginData(h.asPlugin, { lastSeq: 2 });
	expect(h.adapter.write).toHaveBeenCalledExactlyOnceWith(`${dir}/data.last-good.json.tmp`, '{"dataVersion":1,"lastSeq":2}');
	expect(h.names()).toEqual(['data.last-good.json']);
	expect(h.file('data.last-good.json')).toBe('{"dataVersion":1,"lastSeq":2}');
});

it('keeps the previous good copy when writing its replacement fails', async () => {
	const h = harness({ 'data.last-good.json': '{"lastSeq":1}' });
	h.adapter.write.mockRejectedValueOnce(new Error('Disk full'));
	await keepLastGoodPluginData(h.asPlugin, { lastSeq: 2 });
	expect(h.file('data.last-good.json')).toBe('{"lastSeq":1}');
});

describe('data.json versions', () => {
	it('reads unversioned and current data as version 1 without writing a copy', async () => {
		for (const saved of ['{"workerUrl":"https://crate.example"}', '{"dataVersion":1,"workerUrl":"https://crate.example"}']) {
			const h = harness({ 'data.json': saved });
			const data = await loadPluginData(h.asPlugin);
			expect(await upgradeLoadedPluginData(h.asPlugin, data!)).toEqual({ dataVersion: 1, workerUrl: 'https://crate.example' });
			expect(h.names()).toEqual(['data.json']);
			expect(Notice.messages).toEqual([]);
		}
	});

	it('runs each upgrade step in order and keeps the older data before any save', async () => {
		const h = harness({ 'data.json': '{"dataVersion":1,"interval":60,"unknown":"kept"}' });
		const steps = {
			1: (data: Record<string, unknown>) => { const { interval, ...rest } = data; return { ...rest, syncInterval: interval }; },
			2: (data: Record<string, unknown>) => ({ ...data, syncInterval: Number(data.syncInterval) * 2 }),
		};
		const upgraded = await upgradeLoadedPluginData(h.asPlugin, (await loadPluginData(h.asPlugin))!, data => upgradePluginData(data, steps, 3));
		expect(upgraded).toEqual({ dataVersion: 3, syncInterval: 120, unknown: 'kept' });
		expect(JSON.parse(h.file('data.json.v1')!)).toEqual({ dataVersion: 1, interval: 60, unknown: 'kept' });
		expect(JSON.parse(h.file('data.json')!)).toEqual({ dataVersion: 1, interval: 60, unknown: 'kept' });
		expect(h.plugin.saveData).not.toHaveBeenCalled();
	});

	it('never replaces a copy an earlier upgrade kept', async () => {
		const h = harness({ 'data.json': '{"dataVersion":1}', 'data.json.v1': '{"dataVersion":1,"first":true}' });
		await upgradeLoadedPluginData(h.asPlugin, { dataVersion: 1 }, data => upgradePluginData(data, { 1: value => value }, 2));
		expect(h.file('data.json.v1')).toBe('{"dataVersion":1,"first":true}');
	});

	it('stops startup when an upgrade step is missing or the copy cannot be kept', async () => {
		const h = harness();
		await expect(upgradeLoadedPluginData(h.asPlugin, { dataVersion: 1 }, data => upgradePluginData(data, {}, 2))).rejects.toThrow('no upgrade for settings version 1');
		h.adapter.write.mockRejectedValueOnce(new Error('Disk full'));
		await expect(upgradeLoadedPluginData(h.asPlugin, { dataVersion: 1 }, data => upgradePluginData(data, { 1: value => value }, 2))).rejects.toThrow('Disk full');
	});

	it('stops startup for data from a newer Crate and writes nothing', async () => {
		const saved = { dataVersion: 7, workerUrl: 'https://crate.example', futureField: { a: 1 } };
		const h = harness({ 'data.json': JSON.stringify(saved) });
		// Before: the data was read best-effort, startup went on and the next save wrote it back as version 1.
		await expect(upgradeLoadedPluginData(h.asPlugin, (await loadPluginData(h.asPlugin))!)).rejects.toThrow('saved by a newer version of Crate');
		expect(JSON.parse(h.file('data.json')!)).toEqual(saved);
		expect(h.adapter.write).not.toHaveBeenCalled();
		expect(h.plugin.saveData).not.toHaveBeenCalled();
	});

	it.each([0, -1, 1.5, '2', null])('treats an unreadable version %j as version 1', version => {
		expect(upgradePluginData({ dataVersion: version, a: 1 })).toEqual({ status: 'current', from: 1, data: { dataVersion: 1, a: 1 } });
	});
});
