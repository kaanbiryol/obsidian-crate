import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeCrateSettings } from './settings';

describe('normalizeCrateSettings', () => {
	it('normalizes persisted values and rejects unsafe runtime settings', () => {
		const settings = normalizeCrateSettings({
			workerUrl: ' http://worker.example/ ',
			cloudflareAccountId: ' acct ',
			cloudflareTokenExpiresAt: Number.NaN,
			workerName: ' worker ',
			bucketName: ' bucket ',
			databaseId: ' db ',
			lastSync: ' 2026-01-01T00:00:00.000Z ',
			lastSeq: -5,
			deviceId: ' device-1 ',
			ignorePatterns: [' .git/ ', '', 'vault-config/workspace*', '.git/', 42 as never],
			syncOnStartup: 'yes' as never,
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
		expect(settings.cloudflareTokenExpiresAt).toBeNull();
		expect(settings.workerName).toBe('worker');
		expect(settings.bucketName).toBe('bucket');
		expect(settings.databaseId).toBe('db');
		expect(settings.lastSync).toBe('2026-01-01T00:00:00.000Z');
		expect(settings.lastSeq).toBe(DEFAULT_SETTINGS.lastSeq);
		expect(settings.deviceId).toBe('device-1');
		expect(settings.ignorePatterns).toEqual(['.git/', 'vault-config/workspace*']);
		expect(settings.syncOnStartup).toBe(DEFAULT_SETTINGS.syncOnStartup);
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
});
