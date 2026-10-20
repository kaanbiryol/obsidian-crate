import type { EncryptionServerState } from '../../../encryption/server-state';
import { listSharedCheckpoints, createSharedCheckpoint } from '../sync/history-checkpoints';
import { handleFileVersionPreview } from '../sync/file-versions/preview';
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
	handlePutSettings,
	handleUpload,
} from '../sync/index';
import { handleListFileVersions, handleRestoreFileVersion } from '../sync/file-versions/handlers';
import { handleEncryptedSettings } from '../encryption/settings';
import { readEncryptionState } from '../encryption/state';
import type { Env } from '../types';
import type { RouteMethod } from './shared';
import type { MutationAuditContext } from '../request-diagnostics';
import { beginInitialImport, finishInitialImport } from '../sync/initial-import';
import { pruneInitialImport } from '../sync/initial-import-prune';
import { forwardTransferRequest } from '../sync/transfer-dispatch';
import { finishInitialReminderSetup } from '../sync/initial-import-readiness';
import type { UploadCommitters } from '../sync/upload-committers';
import { wakeProjection } from '../coordinator/coordinator';

export async function handleSyncRoute(
	request: Request,
	env: Env,
	uploadCommitters: UploadCommitters,
	path: string,
	method: RouteMethod,
	resetGeneration: string | null,
	audit?: MutationAuditContext,
	encryption?: EncryptionServerState | null,
): Promise<Response | null> {
	const db = env.DB;
	const bucket = env.BUCKET;
    if (path === '/sync/checkpoints' && method === 'GET') return listSharedCheckpoints(bucket);
    if (path === '/sync/checkpoints' && method === 'POST') return createSharedCheckpoint(bucket, db);
    if (path === '/sync/checkpoint' && method === 'GET') return forwardTransferRequest(request, env, '/history-checkpoint');
    if (path === '/sync/checkpoint-file' && method === 'GET') return forwardTransferRequest(request, env, '/history-checkpoint-file');
  if (path === '/sync/import' && method === 'POST') return beginInitialImport(db, async () => {
    if (!await wakeProjection(env)) throw new Error('Unable to resume reminder setup');
  });
  if (path === '/sync/import/complete' && method === 'POST') return finishInitialImport(request, db);
  if (path === '/sync/import/readiness' && method === 'POST') return finishInitialReminderSetup(request, db);
  if (path === '/sync/import/prune' && method === 'POST') return pruneInitialImport(request, db);
  if (path === '/sync/import/upload' && (method === 'POST' || method === 'PUT')) {
    // Hashing, R2 writes and D1 publication use the existing object's CPU allowance.
    // The public Worker has already checked protocol, authorization and maintenance.
    return forwardTransferRequest(request, env, '/import-upload');
  }

	if (path === '/sync/check' && method === 'GET') {
		return await handleCheckChanges(request, db);
	}
	if (path === '/sync/changes' && method === 'GET') {
		return await handleGetChanges(request, db);
	}
	if (path === '/sync/manifest' && method === 'GET') {
		return await handleGetManifest(request, db);
	}
	if (path === '/sync/metadata' && method === 'POST') {
		return await handleGetFileMetadata(request, db);
	}
	if (path === '/sync/upload' && method === 'PUT') {
		return await handleUpload(request, bucket, db, uploadCommitters, encryption, resetGeneration);
	}
	if (path === '/sync/download' && method === 'GET') {
		return await handleDownload(request, bucket, db);
	}
	if (path === '/sync/delete' && method === 'POST') {
		return await handleDelete(request, bucket, db, audit);
	}
	if (path === '/sync/batch-upload' && method === 'POST') {
		return await handleBatchUpload(request, bucket, db, uploadCommitters, encryption, resetGeneration);
	}
	if (path === '/sync/batch-download' && method === 'POST') {
		return forwardTransferRequest(request, env, '/batch-download');
	}
	if (path === '/sync/batch-delete' && method === 'POST') {
		return await handleBatchDelete(request, bucket, db, audit);
	}
	if (path === '/sync/version-preview' && method === 'GET') {
		return await handleFileVersionPreview(request, bucket, db);
	}
	if (path === '/sync/versions' && method === 'GET') {
		return await handleListFileVersions(request, db);
	}
	if (path === '/sync/restore-version' && method === 'POST') {
		return await handleRestoreFileVersion(request, bucket, db);
	}
	if (path === '/settings' && (method === 'GET' || method === 'PUT')) {
		// Encrypted vaults keep shared settings as a D1 ciphertext record instead of the R2 file.
		const encryptionState = await readEncryptionState(db);
		if (encryptionState) return await handleEncryptedSettings(request, db, encryptionState);
		return method === 'GET' ? await handleGetSettings(bucket) : await handlePutSettings(request, bucket);
	}

	return null;
}
