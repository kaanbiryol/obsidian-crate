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
      const failed = (backend.counts.failedNotificationJobs ?? 0) + (backend.counts.failedNotificationProjections ?? 0) + (backend.counts.failedNotificationDeliveries ?? 0);
			results.push({
				name: 'Backend queues',
				status: failed ? 'fail' : pending === 0 ? 'pass' : 'warn',
				message: failed ? `${failed} notification deliveries, jobs or file projections failed; ${pending} background jobs are pending. Check push enrollment and server diagnostics; reschedule missed reminders after repair.` : pending === 0
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
      if (backend.pausedUploadCleanup?.length) results.push({ name: 'Unfinished upload cleanup', status: 'warn',
        message: `${backend.pausedUploadCleanup.length} upload records could not be safely cleaned up. Their records are retained for investigation.` });
      const paused = (backend.pausedNotificationFiles?.length ?? 0) + (backend.pausedNotificationJobs?.length ?? 0);
      if (paused) results.push({ name: 'Paused notification updates', status: 'fail',
        message: `${paused} or more updates are paused because of invalid file content or repeated failures. Repair the reported issue, then select Retry paused notifications in Troubleshooting.` });
      const pausedPaths = new Set(backend.pausedNotificationFiles?.map(file => file.path));
			for (const issue of backend.notificationProjectionIssues ?? []) {
        const stopped = pausedPaths.has(issue.path);
				results.push({ name: `Reminders in ${issue.path}`, status: stopped ? 'fail' : 'warn',
          message: stopped ? `Paused: ${issue.reason}` : issue.reason });
			}
      for (const job of backend.pausedNotificationJobs ?? []) {
        results.push({ name: `Notification ${job.reminderId}`, status: 'fail',
          message: `Paused after ${job.attempts} failed attempts: ${job.error}` });
      }
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
