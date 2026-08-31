import {
	handleBatchDelete,
	handleBatchDownload,
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
import { handleDiagnostics } from '../maintenance/diagnostics';
import type { Env } from '../types';
import type { RouteMethod } from './shared';
import { withDatabase } from './shared';

export async function handleSyncRoute(
	request: Request,
	env: Env,
	path: string,
	method: RouteMethod,
): Promise<Response | null> {
	const db = env.DB;
	const bucket = env.BUCKET;

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
		return await withDatabase(db, requiredDb => handleUpload(request, bucket, requiredDb));
	}
	if (path === '/sync/download' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleDownload(request, bucket, requiredDb));
	}
	if (path === '/sync/delete' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleDelete(request, bucket, requiredDb));
	}
	if (path === '/sync/batch-upload' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleBatchUpload(request, bucket, requiredDb));
	}
	if (path === '/sync/batch-download' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleBatchDownload(request, bucket, requiredDb));
	}
	if (path === '/sync/batch-delete' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleBatchDelete(request, bucket, requiredDb));
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
