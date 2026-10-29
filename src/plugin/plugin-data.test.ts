import { beforeEach, expect, it, vi } from 'vitest';
import type { Plugin } from 'obsidian';
import { Notice } from '../test/mocks/obsidian';
import { keepLastGoodPluginData, loadPluginData } from './plugin-data';

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
	const h = harness({ 'data.last-good.json': '{"lastSeq":1}' });
	await keepLastGoodPluginData(h.asPlugin, { lastSeq: 1 });
	expect(h.adapter.write).not.toHaveBeenCalled();
	await keepLastGoodPluginData(h.asPlugin, { lastSeq: 2 });
	expect(h.adapter.write).toHaveBeenCalledExactlyOnceWith(`${dir}/data.last-good.json.tmp`, '{"lastSeq":2}');
	expect(h.names()).toEqual(['data.last-good.json']);
	expect(h.file('data.last-good.json')).toBe('{"lastSeq":2}');
});

it('keeps the previous good copy when writing its replacement fails', async () => {
	const h = harness({ 'data.last-good.json': '{"lastSeq":1}' });
	h.adapter.write.mockRejectedValueOnce(new Error('Disk full'));
	await keepLastGoodPluginData(h.asPlugin, { lastSeq: 2 });
	expect(h.file('data.last-good.json')).toBe('{"lastSeq":1}');
});
