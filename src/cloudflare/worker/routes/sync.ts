import {
	handleBatchDelete,
	handleBatchDownload,
	handleBatchUpload,
	handleCheckChanges,
	handleDelete,
	handleDownload,
	handleGetChanges,
	handleGetConfig,
	handleGetManifest,
	handleGetSettings,
	handleHealth,
	handlePutSettings,
	handleUpload,
} from '../sync-handlers';
import type { Env } from '../types';
import type { RouteMethod } from './shared';
import { withDatabase } from './shared';

export async function handleSyncRoute(
	request: Request,
	env: Env,
	path: string,
	method: RouteMethod,
): Promise<Response | null> {
	const db = env.DB || null;
	const bucket = env.BUCKET;

	if (path === '/health' && method === 'GET') return await handleHealth();
	if (path === '/sync/check' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleCheckChanges(request, requiredDb));
	}
	if (path === '/sync/changes' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleGetChanges(request, requiredDb));
	}
	if (path === '/sync/manifest' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleGetManifest(request, requiredDb));
	}
	if (path === '/sync/upload' && method === 'PUT') return await handleUpload(request, bucket, db);
	if (path === '/sync/download' && method === 'GET') return await handleDownload(request, bucket, db);
	if (path === '/sync/delete' && method === 'POST') return await handleDelete(request, bucket, db);
	if (path === '/sync/batch-upload' && method === 'POST') return await handleBatchUpload(request, bucket, db);
	if (path === '/sync/batch-download' && method === 'POST') return await handleBatchDownload(request, bucket, db);
	if (path === '/sync/batch-delete' && method === 'POST') return await handleBatchDelete(request, bucket, db);
	if (path === '/sync/config' && method === 'GET') return await handleGetConfig(env);

	if (path === '/settings' && method === 'GET') return await handleGetSettings(bucket);
	if (path === '/settings' && method === 'PUT') return await handlePutSettings(request, bucket);

	return null;
}
