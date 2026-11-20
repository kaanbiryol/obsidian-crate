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

it('marks Crate update bundles, and groups nothing without a config folder', () => {
	const [bundle, replaced] = groupPendingItems(['.obsidian/crate-update/0.14.1.json', remove('.obsidian/crate-update/0.14.0.json')], '.obsidian');
	expect(bundle).toMatchObject({ crateUpdate: true, deleted: false });
	expect(pendingPluginStatus(bundle!)).toBe('Plugin updated');
	expect(pendingPluginStatus(replaced!)).toBe('Older update removed');
	expect(groupPendingItems(['.obsidian/plugins/x/main.js']).map(item => item.plugin)).toEqual([undefined]);
});
