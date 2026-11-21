import { describe, expect, it } from 'vitest';
import type { HostStatus } from '../../../protocol/host-status';
import { describeHostStatus, pairCommand, updateCommand } from './self-hosted-status';

const now = Date.parse('2026-11-21T12:00:00Z');
const healthy: HostStatus = { install: 'npm', startedAt: '2026-11-19T12:00:00Z', lastBackupAt: '2026-11-21T09:00:00Z',
	autoBackup: { on: true, lastFailureAt: null }, publicAccess: 'ready', diskFreeBytes: 50 * 1024 ** 3 };

describe('self-hosted server status', () => {
	it('summarizes a healthy server without warnings', () => {
		expect(describeHostStatus(healthy, now)).toEqual({
			summary: 'Installed with npm · running since 2d ago · last backup 3h ago · daily backups on · reachable from the internet.',
			warnings: [],
		});
	});

	it('warns about failed or missing backups, lost access and a nearly full disk, then points to doctor', () => {
		const { warnings } = describeHostStatus({ ...healthy, install: 'docker', autoBackup: { on: false, lastFailureAt: '2026-11-21T11:00:00Z' },
			publicAccess: 'waiting', diskFreeBytes: 1024 ** 3 }, now);
		expect(warnings).toEqual([
			'The last automatic backup failed 1h ago.',
			'Turn on daily backups on the server computer: docker compose exec crate crate auto-backup --output PATH',
			'Your server is not reachable from the internet right now.',
			'Only 1.0 GB of disk space is left on the server computer.',
			'For details, run docker compose exec crate crate doctor on that computer.',
		]);
	});

	it('names the pair and update commands for each install', () => {
		expect(pairCommand('npx')).toBe('npx @kaanbiryol/crate-server pair --name "My phone"');
		expect(pairCommand(undefined)).toBe('crate-server pair --name "My phone"');
		expect(updateCommand('npm')).toBe('crate-server update');
		expect(updateCommand('docker')).toBe('docker compose pull && docker compose up -d');
	});
});
