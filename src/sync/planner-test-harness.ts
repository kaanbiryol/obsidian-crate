import { vi } from 'vitest';
import type { ChangelogEntry, MutationFailure } from '../protocol/sync-types';
import type { CrateSettings } from '../plugin/settings-types';
import type { IncrementalSyncPlannerContext } from './planner-types';

export function createSettings(overrides: Partial<CrateSettings> = {}): CrateSettings {
	return {
		workerUrl: 'https://worker.example',
		cloudflareDeployment: null,
		lastSync: null,
		lastSeq: 10,
		deviceId: 'dev-1',
		ignorePatterns: [],
		syncOnStartup: false,
		syncOnResume: true,
		syncInterval: 0,
		showStatusBar: true,
		syncHistory: [],
		pushEnabled: false,
		syncDebugLogging: false,
		debounceDelay: 5,
		...overrides,
	};
}
export function createIncrementalHarness(overrides: Partial<{
	settings: Partial<CrateSettings>;
	changes: ChangelogEntry[];
	lastSeq: number;
	hasMore: boolean;
	localChanges: Array<{ path: string; hash: string }>;
	localDeletes: string[];
	shouldIgnore: (path: string) => boolean;
}> = {}) {
	const settings = createSettings(overrides.settings);
	const localManifest = {
		save: vi.fn(async () => {}),
		setEntry: vi.fn(),
		removeEntry: vi.fn(),
		getEntry: vi.fn(),
		getAllPaths: vi.fn(() => []),
		getManifest: vi.fn(() => ({ version: 1, files: {} })),
	};
	const vault = {
		trash: vi.fn(async () => {}),
		getAbstractFileByPath: vi.fn(),
		delete: vi.fn(),
		adapter: {
			exists: vi.fn(async () => false),
			remove: vi.fn(async () => {}),
			trashLocal: vi.fn(async () => {}),
			stat: vi.fn(),
			readBinary: vi.fn(),
		},
	};
	const fileManager = {
		trashFile: vi.fn(async () => {}),
	};
	const api = {
		getChanges: vi.fn(async () => ({
			changes: overrides.changes ?? [],
			lastSeq: overrides.lastSeq ?? settings.lastSeq + 1,
			hasMore: overrides.hasMore ?? false,
		})),
		downloadFile: vi.fn(),
		deleteFile: vi.fn(),
		batchDelete: vi.fn(async (paths: string[]) => ({
			success: true,
			deleted: paths,
			errors: [] as MutationFailure[],
		})),
	};
	const context: IncrementalSyncPlannerContext = {
		settings,
		vault: vault as never,
		fileManager,
		api,
		localManifest,
		shouldIgnore: vi.fn(overrides.shouldIgnore ?? (() => false)),
		getLocalChanges: vi.fn(async () => overrides.localChanges ?? []),
		getLocalDeletes: vi.fn(async () => overrides.localDeletes ?? []),
		parallelDownloadAndSaveFiles: vi.fn(async () => {}),
		processDiff: vi.fn(async () => ({ status: 'applied' as const })),
		prepareUploadFromPath: vi.fn(async () => null),
		uploadPreparedFiles: vi.fn(async () => {}),
		reconcileVersionConflicts: vi.fn(async () => {}),
	};

	return {
		settings,
		localManifest,
		vault,
		fileManager,
		api,
		context,
	};
}
