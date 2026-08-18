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
});
