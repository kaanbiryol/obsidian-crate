import { Notice, type DataAdapter, type Plugin } from 'obsidian';
import { isRecord } from '../platform/validation';
import { errorMessage } from '../platform/logger';
import { createLogger } from '../sync/logger';
import { PLUGIN_DATA_VERSION, upgradePluginData } from './plugin-data-version';

const logger = createLogger('Plugin data');

/** Plugin data as it last loaded, or as of the last save of a Cloudflare restore or deletion
 * record, kept beside `data.json`. Only startup and those saves write it, so the saves after
 * every sync never pay for it. Like `data.json`, it holds no secrets. */
const LAST_GOOD = 'data.last-good.json';

function parseRecord(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? value : null;
	} catch { return null; }
}

/** A replacement copy is written beside the last one and renamed, so an interrupted swap
 * leaves the complete temporary copy to stand in. */
async function readLastGood(adapter: DataAdapter, path: string): Promise<Record<string, unknown> | null> {
	for (const candidate of [path, `${path}.tmp`]) {
		const value = await adapter.exists(candidate) ? parseRecord(await adapter.read(candidate)) : null;
		if (value) return value;
	}
	return null;
}

/** Keeps `data` as the copy recovery falls back to, writing only when it changed. Best effort:
 * without a copy, recovery starts from defaults. */
export async function keepLastGoodPluginData(plugin: Plugin, data: Record<string, unknown>): Promise<void> {
	try {
		const { adapter } = plugin.app.vault;
		const path = `${plugin.manifest.dir}/${LAST_GOOD}`;
		const text = JSON.stringify({ dataVersion: PLUGIN_DATA_VERSION, ...data });
		if (await adapter.exists(path) && await adapter.read(path) === text) return;
		const temporary = `${path}.tmp`;
		await adapter.write(temporary, text);
		// Adapter writes are not atomic and renames do not replace a file, so the previous
		// copy is removed only once the new one is complete.
		if (await adapter.exists(path)) await adapter.remove(path);
		await adapter.rename(temporary, path);
	} catch (error) {
		logger.debug('Did not update the copy of plugin data:', errorMessage(error));
	}
}

/** Loads `data.json`, or null when there is none. Obsidian replaces it in place, so an app
 * closed mid-save can leave it torn. Damaged data is moved aside, never overwritten, and
 * settings come from the last good copy or, without one, from defaults (null). A read
 * failure is not damage: it stops startup with the file untouched. Obsidian's `loadData`
 * answers both damage and read failures with no data, so the file is read here. */
export async function loadPluginData(plugin: Plugin): Promise<Record<string, unknown> | null> {
	const loaded: unknown = await plugin.loadData();
	if (loaded === null || isRecord(loaded)) return loaded;
	const dir = plugin.manifest.dir;
	const { adapter } = plugin.app.vault;
	let data: unknown = null;
	try {
		if (await adapter.exists(`${dir}/data.json`)) data = JSON.parse(await adapter.read(`${dir}/data.json`));
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		data = undefined;
	}
	if (data === null || isRecord(data)) return data;

	const damaged = `data.json.corrupt-${Date.now()}`;
	await plugin.app.vault.adapter.rename(`${dir}/data.json`, `${dir}/${damaged}`);
	const copy = await readLastGood(plugin.app.vault.adapter, `${dir}/${LAST_GOOD}`);
	if (copy) {
		try { await plugin.saveData(copy); }
		catch (error) { logger.warn('Could not restore plugin data from its copy:', errorMessage(error)); }
	}
	logger.error(`Plugin data was damaged and moved to ${damaged}.`);
	new Notice(copy
		? `Crate could not read its settings and restored the last good copy. Recent setting changes may need to be made again. The damaged file is kept as ${damaged} in Crate's plugin folder.`
		: `Crate could not read its settings and started with defaults. Sync is disconnected: reconnect in Crate settings. The damaged file is kept as ${damaged} in Crate's plugin folder.`, 0);
	return copy;
}

/** Brings loaded plugin data to this build's layout. Before a save can replace an older
 * layout, the data as loaded is kept beside `data.json`. Failing to keep that copy, or data
 * from a newer Crate, stops startup rather than risk losing settings. */
export async function upgradeLoadedPluginData(
	plugin: Plugin,
	data: Record<string, unknown>,
	upgrade: (data: Record<string, unknown>) => ReturnType<typeof upgradePluginData> = upgradePluginData,
): Promise<Record<string, unknown>> {
	const result = upgrade(data);
	if (result.status === 'current') return result.data;
	const name = `data.json.v${result.from}`;
	const { adapter } = plugin.app.vault;
	const path = `${plugin.manifest.dir}/${name}`;
	if (!await adapter.exists(path)) await adapter.write(path, JSON.stringify(data));
	logger.info(`Upgraded plugin data from version ${result.from} to ${PLUGIN_DATA_VERSION}; kept ${name}.`);
	return result.data;
}
