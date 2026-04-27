import { describe, expect, it } from 'vitest';
import { buildPersistedCrateSettings, DEFAULT_SETTINGS, normalizeCrateSettings } from './settings';
import { MAX_SYNC_HISTORY_PATHS } from './types';

describe('normalizeCrateSettings', () => {
	it('normalizes persisted values and rejects unsafe runtime settings', () => {
		const settings = normalizeCrateSettings({
			workerUrl: ' http://worker.example/ ',
			cloudflareAccountId: ' acct ',
			workerName: ' worker ',
			bucketName: ' bucket ',
			databaseId: ' db ',
			lastSync: ' 2026-01-01T00:00:00.000Z ',
			lastSeq: -5,
			deviceId: ' device-1 ',
			ignorePatterns: [' .git/ ', '', 'vault-config/workspace*', '.git/', 42 as never],
			syncOnStartup: 'yes' as never,
			syncOnResume: 'yes' as never,
			syncInterval: -30,
			showStatusBar: false,
			syncHistory: [
				{
					timestamp: ' 2026-01-01T00:00:00.000Z ',
					type: 'sync',
					success: true,
					uploaded: 1,
					downloaded: 2,
					deleted: 3,
					errorCount: 0,
					conflictCount: 0,
					uploadedPaths: [' notes/a.md ', 'notes/a.md'],
				},
				{ timestamp: '2026-01-01T00:00:00.000Z', type: 'invalid' },
			] as never,
			pushEnabled: true,
		}, 'vault-config');

		expect(settings.workerUrl).toBe('');
		expect(settings.cloudflareAccountId).toBe('acct');
		expect(settings.workerName).toBe('worker');
		expect(settings.bucketName).toBe('bucket');
		expect(settings.databaseId).toBe('db');
		expect(settings.lastSync).toBe('2026-01-01T00:00:00.000Z');
		expect(settings.lastSeq).toBe(DEFAULT_SETTINGS.lastSeq);
		expect(settings.deviceId).toBe('device-1');
		expect(settings.ignorePatterns).toEqual(['.git/', 'vault-config/workspace*']);
		expect(settings.syncOnStartup).toBe(DEFAULT_SETTINGS.syncOnStartup);
		expect(settings.syncOnResume).toBe(DEFAULT_SETTINGS.syncOnResume);
		expect(settings.syncInterval).toBe(DEFAULT_SETTINGS.syncInterval);
		expect(settings.showStatusBar).toBe(false);
		expect(settings.syncHistory).toEqual([
			{
				timestamp: '2026-01-01T00:00:00.000Z',
				type: 'sync',
				success: true,
				uploaded: 1,
				downloaded: 2,
				deleted: 3,
				errorCount: 0,
				conflictCount: 0,
				uploadedPaths: ['notes/a.md'],
			},
		]);
		expect(settings.pushEnabled).toBe(true);
		expect(settings.syncDebugLogging).toBe(DEFAULT_SETTINGS.syncDebugLogging);
		expect(settings.debounceDelay).toBe(DEFAULT_SETTINGS.debounceDelay);
	});

	it('preserves valid syncOnResume, syncDebugLogging, and debounceDelay values', () => {
		const settings = normalizeCrateSettings({
			syncOnResume: false,
			syncDebugLogging: true,
			debounceDelay: 10,
		}, 'vault-config');

		expect(settings.syncOnResume).toBe(false);
		expect(settings.syncDebugLogging).toBe(true);
		expect(settings.debounceDelay).toBe(10);
	});

	it('rejects invalid syncDebugLogging and debounceDelay values', () => {
		const settings = normalizeCrateSettings({
			syncDebugLogging: 'yes' as never,
			debounceDelay: -3,
		}, 'vault-config');

		expect(settings.syncDebugLogging).toBe(DEFAULT_SETTINGS.syncDebugLogging);
		expect(settings.debounceDelay).toBe(DEFAULT_SETTINGS.debounceDelay);
	});

	it('always includes the workspace ignore pattern for the active config directory', () => {
		const settings = normalizeCrateSettings({ ignorePatterns: [] }, '/custom-config/');

		expect(settings.ignorePatterns).toEqual(['custom-config/workspace*']);
	});

	it('rejects worker URLs with credentials, query strings, and fragments', () => {
		const configDir = 'vault-config';
		expect(normalizeCrateSettings({ workerUrl: 'https://user:pass@worker.example' }, configDir).workerUrl).toBe('');
		expect(normalizeCrateSettings({ workerUrl: 'https://worker.example?token=1' }, configDir).workerUrl).toBe('');
		expect(normalizeCrateSettings({ workerUrl: 'https://worker.example/#frag' }, configDir).workerUrl).toBe('');
		expect(normalizeCrateSettings({ workerUrl: 'https://worker.example/api/' }, configDir).workerUrl).toBe('https://worker.example/api');
	});

	it('caps persisted sync history file lists to avoid oversized settings payloads', () => {
		const uploadedPaths = Array.from({ length: MAX_SYNC_HISTORY_PATHS + 10 }, (_, index) => `notes/${index}.md`);

		const settings = normalizeCrateSettings({
			syncHistory: [
				{
					timestamp: '2026-01-01T00:00:00.000Z',
					type: 'sync',
					success: true,
					uploaded: uploadedPaths.length,
					downloaded: 0,
					deleted: 0,
					errorCount: 0,
					conflictCount: 0,
					uploadedPaths,
				},
			],
		}, 'vault-config');

		expect(settings.syncHistory[0]?.uploadedPaths).toHaveLength(MAX_SYNC_HISTORY_PATHS);
		expect(settings.syncHistory[0]?.uploadedPaths?.[0]).toBe('notes/0.md');
		expect(settings.syncHistory[0]?.uploadedPaths?.at(-1)).toBe(`notes/${MAX_SYNC_HISTORY_PATHS - 1}.md`);
	});

	it('omits deviceId from persisted settings so device identity stays local', () => {
		const persisted = buildPersistedCrateSettings({
			...DEFAULT_SETTINGS,
			deviceId: 'device-local-only',
		});

		expect('deviceId' in persisted).toBe(false);
		expect(persisted.workerUrl).toBe(DEFAULT_SETTINGS.workerUrl);
	});
});
