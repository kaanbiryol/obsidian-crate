import { normalizeRemindersSettings } from '../reminders/settings';
import { testFrozenFixtures } from '../test/frozen-fixtures';
import { PLUGIN_DATA_VERSION, upgradePluginData } from './plugin-data-version';
import { buildPersistedCrateSettings, normalizeCrateSettings } from './settings';

/**
 * Frozen `data.json` samples. A saved file must keep loading into the same settings after
 * every update, including files written before `dataVersion` existed. When a release changes
 * the layout, raise PLUGIN_DATA_VERSION, register its upgrade step and append a fixture for the
 * new version (see src/test/frozen-fixtures.ts). Never edit an existing fixture.
 */
const configDir = '.obsidian';

function written(): Record<string, unknown> {
	const settings = normalizeCrateSettings({
		workerUrl: 'https://crate.example.workers.dev',
		lastSeq: 42,
		automaticSync: true,
		syncInterval: 120,
		debounceDelay: 9,
		pushEnabled: true,
		ignorePatterns: ['.git/', 'Private/'],
		debugLogging: true,
		getStartedDismissed: true,
		syncCrateUpdates: false,
		reading: { enabled: true, confirmed: true, folderPath: 'Saved' },
	}, configDir);
	const reminders = normalizeRemindersSettings({ enabled: true, confirmed: true, remindersFolderPath: 'Tasks', listStyle: 'grouped', upcomingDaysDefault: 14, desktopNotifications: false } as never);
	return { dataVersion: PLUGIN_DATA_VERSION, ...buildPersistedCrateSettings(settings), reminders };
}

function decode(stored: Record<string, unknown>) {
	const { data } = upgradePluginData(stored);
	return { settings: normalizeCrateSettings(data, configDir), reminders: normalizeRemindersSettings(data.reminders as never) };
}

testFrozenFixtures(new URL('./__fixtures__/', import.meta.url), [
	{ file: 'plugin-data.unversioned.json', stored: () => { const { dataVersion, ...rest } = written(); void dataVersion; return rest; }, decode },
	{ file: 'plugin-data.v1.json', stored: written, decode },
]);
