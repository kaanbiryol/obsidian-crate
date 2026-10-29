import { DEFAULT_SETTINGS, type CrateSettings } from '../../plugin/settings-types';

/** The shipped defaults for a device connected to a test Worker, with automatic
 * sync on, no periodic timer and Reading off. Overrides replace whole fields. */
export function createTestSettings(overrides: Partial<CrateSettings> = {}): CrateSettings {
	return {
		...structuredClone(DEFAULT_SETTINGS),
		workerUrl: 'https://worker.example',
		automaticSync: true,
		syncInterval: 0,
		...overrides,
	};
}
