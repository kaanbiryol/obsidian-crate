import { decodePendingChange, type PendingKey } from '../../sync/pending/pending-change';
import { crateUpdateFolder, crateUpdateVersion } from '../../plugin/crate-update/bundle';

/** The files Obsidian installs for a plugin. They sync as one row, so no device gets part of one. */
const PLUGIN_CODE_FILES = new Set(['main.js', 'manifest.json', 'styles.css']);
// NUL cannot occur in a sync path, so a group's row key never matches a pending key.
const PLUGIN_ROW_PREFIX = '\0plugin:';
const CRATE_UPDATE_ROW_KEY = '\0crate-update';

/** One row of the Pending list. */
export interface PendingItem {
	/** A single change's own pending key, or a plugin group's own key. */
	key: string;
	/** The pending keys this row checks, syncs and discards together. */
	keys: PendingKey[];
	/** The file's path, or the plugin's folder. */
	path: string;
	deleted: boolean;
	/** Crate's own update bundles, which are described rather than compared. A new bundle
	 * and the older one it replaces share this row, so they sync together. */
	crateUpdate?: boolean;
	/** A plugin's code files, named by its folder until its manifest name is known. */
	plugin?: { folder: string };
}

/** Groups each plugin's code files into one row, and Crate's update bundles into another,
 * each at the position of its first file. */
export function groupPendingItems(keys: PendingKey[], configDir?: string): PendingItem[] {
	const pluginsFolder = configDir === undefined ? undefined : `${configDir}/plugins/`;
	const items: PendingItem[] = [];
	const groups = new Map<string, PendingItem>();
	let crateUpdate: PendingItem | undefined;
	for (const key of keys) {
		const { kind, path } = decodePendingChange(key);
		const deleted = kind === 'delete';
		if (configDir !== undefined && crateUpdateVersion(path, configDir)) {
			if (crateUpdate) {
				crateUpdate.keys.push(key);
				// Older update removed only when no newer bundle arrives with it.
				crateUpdate.deleted &&= deleted;
			} else {
				crateUpdate = { key: CRATE_UPDATE_ROW_KEY, keys: [key], path: crateUpdateFolder(configDir), deleted, crateUpdate: true };
				items.push(crateUpdate);
			}
			continue;
		}
		const folder = pluginsFolder && path.startsWith(pluginsFolder) ? pluginCodeFolder(path.slice(pluginsFolder.length)) : undefined;
		if (!folder) {
			items.push({ key, keys: [key], path, deleted });
			continue;
		}
		const group = groups.get(folder);
		if (group) {
			group.keys.push(key);
			// A plugin is removed only when every one of its code files is.
			group.deleted &&= deleted;
			continue;
		}
		const item: PendingItem = { key: PLUGIN_ROW_PREFIX + folder, keys: [key], path: pluginsFolder + folder, deleted, plugin: { folder } };
		groups.set(folder, item);
		items.push(item);
	}
	return items;
}

/** The plugin folder for one of its code files directly inside it, or undefined for any other file. */
function pluginCodeFolder(relative: string): string | undefined {
	const parts = relative.split('/');
	return parts.length === 2 && parts[0] && PLUGIN_CODE_FILES.has(parts[1]!) ? parts[0] : undefined;
}

/** A plugin row's name and status, such as "Dataview" and "Plugin updated". */
export function pendingPluginStatus(item: Pick<PendingItem, 'deleted' | 'crateUpdate'>): string {
	if (item.crateUpdate && item.deleted) return 'Older update removed';
	return item.deleted ? 'Plugin removed' : 'Plugin updated';
}

/** Reads a plugin's display name from its manifest; resolves undefined when it cannot be read. */
export type PluginNameReader = (folder: string) => Promise<string | undefined>;
