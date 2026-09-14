import {
	handleBatchDelete,
	handleBatchUpload,
	handleCheckChanges,
	handleDelete,
	handleDownload,
	handleGetChanges,
	handleGetFileMetadata,
	handleGetManifest,
	handleGetSettings,
	handleHealth,
	handlePutSettings,
	handleUpload,
} from '../sync';
import { handleListFileVersions, handleRestoreFileVersion } from '../file-version-handlers';
import { retryPausedNotifications } from '../notification-retry-handler';
import { handleDiagnostics } from '../maintenance/diagnostics';
import type { Env } from '../types';
import type { RouteMethod } from './shared';
import { withDatabase } from './shared';
import type { MutationAuditContext } from '../request-diagnostics';
import { beginInitialImport, finishInitialImport } from '../initial-import';
import { pruneInitialImport } from '../initial-import-prune';
import { forwardTransferRequest } from '../transfer-dispatch';
import { finishInitialReminderSetup } from '../initial-import-readiness';

export async function handleSyncRoute(
	request: Request,
	env: Env,
	path: string,
	method: RouteMethod,
	audit?: MutationAuditContext,
): Promise<Response | null> {
	const db = env.DB;
  if (path === '/notifications/retry' && method === 'POST') return retryPausedNotifications(db);
	const bucket = env.BUCKET;
  if (path === '/sync/import' && method === 'POST') return beginInitialImport(db, async () => {
    const coordinator = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
    const response = await coordinator.fetch('https://do/project', { method: 'POST' });
    if (!response.ok) throw new Error('Unable to resume reminder setup');
  });
  if (path === '/sync/import/complete' && method === 'POST') return finishInitialImport(request, db);
  if (path === '/sync/import/readiness' && method === 'POST') return finishInitialReminderSetup(request, db);
  if (path === '/sync/import/prune' && method === 'POST') return pruneInitialImport(request, db);
  if (path === '/sync/import/upload' && (method === 'POST' || method === 'PUT')) {
    // Hashing, R2 writes and D1 publication use the existing object's CPU allowance.
    // The public Worker has already checked protocol, authorization and maintenance.
    return forwardTransferRequest(request, env, '/import-upload');
  }

	if (path === '/health' && method === 'GET') return await handleHealth();
	if (path === '/diagnostics' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleDiagnostics(requiredDb));
	}
	if (path === '/sync/check' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleCheckChanges(request, requiredDb));
	}
	if (path === '/sync/changes' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleGetChanges(request, requiredDb));
	}
	if (path === '/sync/manifest' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleGetManifest(request, requiredDb));
	}
	if (path === '/sync/metadata' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleGetFileMetadata(request, requiredDb));
	}
	if (path === '/sync/upload' && method === 'PUT') {
		return await withDatabase(db, requiredDb => handleUpload(request, bucket, requiredDb, env.commitUpload));
	}
	if (path === '/sync/download' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleDownload(request, bucket, requiredDb));
	}
	if (path === '/sync/delete' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleDelete(request, bucket, requiredDb, audit));
	}
	if (path === '/sync/batch-upload' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleBatchUpload(request, bucket, requiredDb, env.commitUpload, env.commitNewFiles));
	}
	if (path === '/sync/batch-download' && method === 'POST') {
		return forwardTransferRequest(request, env, '/batch-download');
	}
	if (path === '/sync/batch-delete' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleBatchDelete(request, bucket, requiredDb, audit));
	}
	if (path === '/sync/versions' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleListFileVersions(request, requiredDb));
	}
	if (path === '/sync/restore-version' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleRestoreFileVersion(request, bucket, requiredDb));
	}
	if (path === '/settings' && method === 'GET') return await handleGetSettings(bucket);
	if (path === '/settings' && method === 'PUT') return await handlePutSettings(request, bucket);

	return null;
}
