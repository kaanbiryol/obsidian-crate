import type { SyncApiClient } from './api';

type DiagnosticStatus = 'pass' | 'fail' | 'warn';

export interface DiagnosticResult {
	name: string;
	status: DiagnosticStatus;
	message: string;
}

type DiagnosticClient = Pick<SyncApiClient, 'testConnection' | 'getManifest'>
	& Partial<Pick<SyncApiClient, 'getDiagnostics'>>;

export async function runSyncDiagnostics(client: DiagnosticClient | null): Promise<DiagnosticResult[]> {
	if (!client) {
		return [{
			name: 'Configuration',
			status: 'warn',
			message: 'Sync client is not configured.',
		}];
	}

	const connection = await client.testConnection();
	if (!connection.success) {
		return [{
			name: 'Server connection',
			status: 'fail',
			message: connection.error || 'Connection failed.',
		}];
	}

	const results: DiagnosticResult[] = [{
		name: 'Server connection',
		status: 'pass',
		message: 'Server protocol, authentication, and health checks passed.',
	}];

	try {
		const manifest = await client.getManifest();
		results.push({
			name: 'Manifest access',
			status: 'pass',
			message: `Manifest is reachable (${Object.keys(manifest.files).length} files).`,
		});
	} catch (error) {
		results.push({
			name: 'Manifest access',
			status: 'fail',
			message: error instanceof Error ? error.message : String(error),
		});
	}

	if (client.getDiagnostics) {
		try {
			const backend = await client.getDiagnostics();
			const pending = backend.counts.pendingObjectCleanup + backend.counts.pendingNotificationJobs + (backend.counts.pendingNotificationProjections ?? 0);
      const failed = (backend.counts.failedNotificationJobs ?? 0) + (backend.counts.failedNotificationProjections ?? 0);
			results.push({
				name: 'Backend queues',
				status: failed ? 'fail' : pending === 0 ? 'pass' : 'warn',
				message: failed ? `${failed} notification jobs or file projections failed; ${pending} background jobs are pending. Split oversized reminder notes and check server diagnostics.` : pending === 0
					? `Storage metadata is healthy (${backend.counts.retainedVersions} recoverable versions).`
					: `${pending} background cleanup or notification jobs are waiting to run.`,
			});
			results.push({
				name: 'Worker maintenance',
				status: backend.lastMaintenanceError || !backend.lastMaintenanceAt ? 'warn' : 'pass',
				message: backend.lastMaintenanceError
					? `Last run reported: ${backend.lastMaintenanceError}`
					: backend.lastMaintenanceAt
					? `Last ran ${backend.lastMaintenanceAt}.`
					: 'No scheduled maintenance run has been recorded yet.',
			});
		} catch (error) {
			results.push({
				name: 'Backend diagnostics',
				status: 'warn',
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return results;
}
