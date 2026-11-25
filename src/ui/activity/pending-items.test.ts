import { expect, it } from 'vitest';
import { pendingChangeKey } from '../../sync/pending/pending-change';
import { groupPendingItems, pendingPluginStatus } from './pending-items';

const remove = (path: string) => pendingChangeKey('delete', path);

it('groups each plugin folder\'s code files into one row at its first file, and leaves its other files as rows', () => {
	const keys = ['a.md', '.obsidian/plugins/dataview/main.js', '.obsidian/plugins/dataview/data.json',
		'.obsidian/plugins/dataview/manifest.json', '.obsidian/plugins/dataview/lib/worker.js', '.obsidian/plugins/tasks/styles.css'];
	const items = groupPendingItems(keys, '.obsidian');
	expect(items.map(item => ({ path: item.path, keys: item.keys, plugin: item.plugin?.folder }))).toEqual([
		{ path: 'a.md', keys: ['a.md'], plugin: undefined },
		{ path: '.obsidian/plugins/dataview', keys: ['.obsidian/plugins/dataview/main.js', '.obsidian/plugins/dataview/manifest.json'], plugin: 'dataview' },
		{ path: '.obsidian/plugins/dataview/data.json', keys: ['.obsidian/plugins/dataview/data.json'], plugin: undefined },
		{ path: '.obsidian/plugins/dataview/lib/worker.js', keys: ['.obsidian/plugins/dataview/lib/worker.js'], plugin: undefined },
		{ path: '.obsidian/plugins/tasks', keys: ['.obsidian/plugins/tasks/styles.css'], plugin: 'tasks' },
	]);
	// A group's row key never matches a pending key, so it cannot collide with a file row.
	expect(new Set(items.map(item => item.key)).size).toBe(items.length);
	expect(items.filter(item => item.plugin).every(item => !keys.includes(item.key))).toBe(true);
});

it('calls a plugin removed only when every code file is deleted', () => {
	const [removed] = groupPendingItems([remove('.obsidian/plugins/old/main.js'), remove('.obsidian/plugins/old/manifest.json')], '.obsidian');
	const [mixed] = groupPendingItems(['.obsidian/plugins/x/main.js', remove('.obsidian/plugins/x/styles.css')], '.obsidian');
	expect(pendingPluginStatus(removed!)).toBe('Plugin removed');
	expect(pendingPluginStatus(mixed!)).toBe('Plugin updated');
});

it('groups Crate update bundles into one row, and groups nothing without a config folder', () => {
	const keys = ['a.md', remove('.obsidian/crate-update/0.14.0.json'), 'b.md', '.obsidian/crate-update/0.14.1.json'];
	const items = groupPendingItems(keys, '.obsidian');
	// Before: the new bundle and the one it replaced showed as two Crate rows.
	expect(items.map(item => item.path)).toEqual(['a.md', '.obsidian/crate-update', 'b.md']);
	const bundle = items[1]!;
	expect(bundle).toMatchObject({ crateUpdate: true, deleted: false, keys: [keys[1], keys[3]] });
	expect(keys).not.toContain(bundle.key);
	expect(pendingPluginStatus(bundle)).toBe('Plugin updated');
	const [replaced] = groupPendingItems([remove('.obsidian/crate-update/0.14.0.json')], '.obsidian');
	expect(pendingPluginStatus(replaced!)).toBe('Older update removed');
	// A conflict copy is not a bundle, so it stays a file row.
	expect(groupPendingItems(['.obsidian/crate-update/0.14.1 (conflict).json'], '.obsidian')[0]).not.toHaveProperty('crateUpdate');
	expect(groupPendingItems(['.obsidian/plugins/x/main.js']).map(item => item.plugin)).toEqual([undefined]);
});
