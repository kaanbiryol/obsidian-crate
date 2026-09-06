import { describe, expect, it } from 'vitest';
import { buildPersistedCrateSettings, DEFAULT_SETTINGS, normalizeCrateSettings } from './settings';
import { MAX_SYNC_HISTORY_PATHS } from './settings-types';

describe('normalizeCrateSettings', () => {
	it('keeps valid non-secret Cloudflare deployment metadata', () => {
		const settings = normalizeCrateSettings({
			cloudflareDeployment: {
				deploymentId: '0123456789abcdef',
				accountId: '0123456789abcdef0123456789abcdef',
				accountName: 'Personal account',
				workerName: 'crate-0123456789abcdef',
				d1DatabaseName: 'crate-0123456789abcdef',
				d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
				r2BucketName: 'crate-0123456789abcdef',
				workersSubdomain: 'my-workers-subdomain',
				lastDeployedVersion: '0.1.0',
				lastDeployedFingerprint: 'f'.repeat(64),
			},
		}, 'vault-config');

		expect(settings.cloudflareDeployment?.workerName).toBe('crate-0123456789abcdef');
	});

	it('drops malformed Cloudflare deployment metadata', () => {
		const settings = normalizeCrateSettings({
			cloudflareDeployment: {
				deploymentId: 'not-random',
				accountId: null,
				accountName: null,
				workerName: 'shared-worker',
				d1DatabaseName: 'shared-db',
				d1DatabaseId: null,
				r2BucketName: 'shared-bucket',
				workersSubdomain: null,
				lastDeployedVersion: null,
				lastDeployedFingerprint: null,
			},
		}, 'vault-config');

		expect(settings.cloudflareDeployment).toBeNull();
	});

	it('normalizes persisted values and rejects unsafe runtime settings', () => {
		const settings = normalizeCrateSettings({
			workerUrl: ' http://worker.example/ ',
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
		expect(settings.lastSync).toBe('2026-01-01T00:00:00.000Z');
		expect(settings.lastSeq).toBe(DEFAULT_SETTINGS.lastSeq);
		expect(settings.deviceId).toBe(DEFAULT_SETTINGS.deviceId);
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
				merged: 0,
				deleted: 3,
				errorCount: 0,
				conflictCount: 0,
				uploadedPaths: ['notes/a.md'],
			},
		]);
		expect(settings.pushEnabled).toBe(true);
		expect(settings.debugLogging).toBe(DEFAULT_SETTINGS.debugLogging);
		expect(settings.debounceDelay).toBe(DEFAULT_SETTINGS.debounceDelay);
	});

	it('preserves valid syncOnResume, debugLogging, and debounceDelay values', () => {
		const settings = normalizeCrateSettings({
			syncOnResume: false,
			debugLogging: true,
			debounceDelay: 10,
		}, 'vault-config');

		expect(settings.syncOnResume).toBe(false);
		expect(settings.debugLogging).toBe(true);
		expect(settings.debounceDelay).toBe(10);
	});

	it('rejects invalid debugLogging and debounceDelay values', () => {
		const settings = normalizeCrateSettings({
			debugLogging: 'yes' as never,
			debounceDelay: -3,
		}, 'vault-config');

		expect(settings.debugLogging).toBe(DEFAULT_SETTINGS.debugLogging);
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
					merged: 0,
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
