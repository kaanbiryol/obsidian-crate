import { isRecord } from '../platform/validation';

/** The `data.json` layout this build reads and writes. Raise it, and register a step below,
 * when a release renames, moves or reinterprets a saved field. Adding an optional field that
 * normalization defaults does not need a new version. */
export const PLUGIN_DATA_VERSION = 1;

type PluginDataRecord = Record<string, unknown>;

/** `MIGRATIONS[n]` turns version `n` data into version `n + 1`. Steps are pure and must not
 * drop fields they do not understand. Released steps never change. */
const MIGRATIONS: Readonly<Record<number, (data: PluginDataRecord) => PluginDataRecord>> = {};

export interface PluginDataUpgrade { status: 'current' | 'upgraded'; data: PluginDataRecord; from: number }

/** Data saved before versioning has no `dataVersion` and is version 1. */
function savedPluginDataVersion(data: PluginDataRecord): number | null {
	const version = data.dataVersion ?? 1;
	return Number.isSafeInteger(version) && (version as number) >= 1 ? version as number : null;
}

export function upgradePluginData(
	data: PluginDataRecord,
	migrations: Readonly<Record<number, (data: PluginDataRecord) => PluginDataRecord>> = MIGRATIONS,
	target = PLUGIN_DATA_VERSION,
): PluginDataUpgrade {
	// An unreadable version is treated like the oldest layout; normalization validates every field.
	const from = savedPluginDataVersion(data) ?? 1;
	// A newer layout may rename or reinterpret fields this build would then save over or sync
	// with defaults, so startup stops and the file stays as the newer Crate wrote it.
	if (from > target) throw new Error(`Crate's settings were saved by a newer version of Crate (settings version ${from}). Update Crate on this device to use them.`);
	let next = structuredClone(data);
	for (let version = from; version < target; version++) {
		const step = migrations[version];
		if (!step) throw new Error(`Crate has no upgrade for settings version ${version}.`);
		const migrated = step(next);
		if (!isRecord(migrated)) throw new Error(`Settings upgrade from version ${version} returned no settings.`);
		next = migrated;
	}
	return { status: from === target ? 'current' : 'upgraded', data: { ...next, dataVersion: target }, from };
}
