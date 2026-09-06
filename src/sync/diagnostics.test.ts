import { describe, expect, it, vi } from 'vitest';
import { runSyncDiagnostics } from './diagnostics';

describe('runSyncDiagnostics', () => {
	it('checks server compatibility, authentication, health, and manifest access', async () => {
		const client = {
			testConnection: vi.fn(async () => ({ success: true })),
			getManifest: vi.fn(async () => ({
				version: 1,
				files: {
					'a.md': { hash: 'hash', size: 1, modified: 'now' },
				},
			})),
		};

		await expect(runSyncDiagnostics(client as never)).resolves.toEqual([
			{
				name: 'Server connection',
				status: 'pass',
				message: 'Server protocol, authentication, and health checks passed.',
			},
			{
				name: 'Manifest access',
				status: 'pass',
				message: 'Manifest is reachable (1 files).',
			},
		]);
	});

	it('stops after a failed connection check', async () => {
		const getManifest = vi.fn();
		const client = {
			testConnection: vi.fn(async () => ({ success: false, error: 'Invalid token' })),
			getManifest,
		};

		await expect(runSyncDiagnostics(client as never)).resolves.toEqual([{
			name: 'Server connection',
			status: 'fail',
			message: 'Invalid token',
		}]);
		expect(getManifest).not.toHaveBeenCalled();
	});

	it.each([0, 1])('surfaces queue pressure and terminal delivery failures: %i', async failedNotificationDeliveries => {
		const client = {
			testConnection: vi.fn(async () => ({ success: true })),
			getManifest: vi.fn(async () => ({ version: 1, files: {} })),
			getDiagnostics: vi.fn(async () => ({
				status: 'ok' as const,
				counts: {
					files: 0,
					changelog: 0,
					retainedVersions: 2,
					pendingObjectCleanup: 1,
					pendingNotificationJobs: 2,
					failedNotificationDeliveries,
					scheduledReminders: 0,
					activeAuthTokens: 1,
					activePushSubscriptions: 0,
					disabledPushSubscriptions: 0,
				},
				lastMaintenanceAt: null,
				lastMaintenanceError: null,
			})),
		};

		const results = await runSyncDiagnostics(client);

		const backendQueues = results.find(result => result.name === 'Backend queues');
		expect(backendQueues).toMatchObject({ status: failedNotificationDeliveries ? 'fail' : 'warn' });
		if (failedNotificationDeliveries) expect(backendQueues?.message).toContain('reschedule missed reminders');
		expect(backendQueues?.message).toContain('3');
		expect(results.find(result => result.name === 'Worker maintenance')).toMatchObject({ status: 'warn' });
	});
});
