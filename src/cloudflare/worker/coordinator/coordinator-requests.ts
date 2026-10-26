import { armNotificationCoordinator } from '../notifications/lifecycle';
import { fetchWorkerRequest } from '../request-handler';
import { REMINDER_CACHE_PARSER_VERSION } from '../reminders/cache/types';
import type { Env } from '../types';

import { publishExtraction, type Publication } from '../reading/extraction/jobs';
import { commitSealedReadingNote, type SealedReadingNote } from '../reading/sealed-note';
import { getSharedCheckpoint, downloadCheckpointFile } from '../sync/history-checkpoints';
import { drainNotificationJobs } from '../notifications/outbox';
import { COORDINATOR_PATHS, INTERNAL_MUTATION_HEADER, REMINDERS_ENABLED_HEADER, TRANSFER_PATHS } from './coordinator';
import { uploadInitialFiles } from '../sync/import/initial-import-upload';
import { handleBatchDownload } from '../sync/batch/download';
import { prepareCoordinatedNewFiles, commitCoordinatedNewFiles } from '../sync/staging/bulk-upload-dispatch';
import { prepareCoordinatedUpload, commitCoordinatedUpload } from '../sync/staging/staged-upload-dispatch';
import { scheduleMaintenance } from '../maintenance/schedule';

export type StateLock = <T>(action: () => Promise<T>) => Promise<T>;

/** Preparation may read large bodies; only publication and state changes hold the lock. */
export async function handleCoordinatorRequest(
	request: Request, state: DurableObjectState, env: Env,
	withStateLock: StateLock, handleReminder: () => Promise<Response>,
): Promise<Response> {
	const path = new URL(request.url).pathname;
	if ((path === TRANSFER_PATHS.syncUpload && request.method === 'PUT') || (path === TRANSFER_PATHS.syncBatchUpload && request.method === 'POST')) {
		// Reauthenticate inside the transfer queue so reset/revocation fences waiting writers.
		const target = new URL(request.url);
		target.pathname = path === TRANSFER_PATHS.syncUpload ? '/sync/upload' : '/sync/batch-upload';
		return withStateLock(() => fetchWorkerRequest(new Request(target, request), env, { kind: 'transfer' }));
	}
	if (path === COORDINATOR_PATHS.commitNewFiles && request.method === 'POST') {
		const prepared = await prepareCoordinatedNewFiles(request, env);
		return withStateLock(() => commitCoordinatedNewFiles(prepared, state, env));
	}
	if (path === COORDINATOR_PATHS.commitUpload && request.method === 'POST') {
		const prepared = await prepareCoordinatedUpload(request, env);
		if (prepared instanceof Response) return prepared;
		return withStateLock(() => commitCoordinatedUpload(prepared, state, env));
	}
	// Every poll ensures the projection coordinator. Once armed for this parser
	// version, answer without queuing behind mutations or notification passes.
	if (path === COORDINATOR_PATHS.ensure && request.method === 'POST'
		&& await state.storage.get<number>('projectionParserVersion') === REMINDER_CACHE_PARSER_VERSION) return new Response(null, { status: 204 });
	// An already scheduled maintenance episode needs no state change; a running
	// pass holds this object's lock, and mutations must not wait for it.
	if (path === COORDINATOR_PATHS.maintain && request.method === 'POST' && await state.storage.get<boolean>('maintenanceCoordinator')
		&& await state.storage.getAlarm() !== null) return new Response(null, { status: 204 });
	// Schedule cleanup before queuing, so a running maintenance pass delays only
	// this request rather than every coordinated mutation behind it.
	if (request.headers.get(INTERNAL_MUTATION_HEADER) === '1') await scheduleMaintenance(env, state);
	return withStateLock(async () => {
		if (path === COORDINATOR_PATHS.readingWake && request.method === 'POST') {
			await state.storage.put('readingCoordinator', true);
			if (await state.storage.getAlarm() === null) await state.storage.setAlarm(Date.now() + 100);
			return new Response(null, { status: 204 });
		}
		if (path === COORDINATOR_PATHS.readingPublish && request.method === 'POST') {
			await publishExtraction(env, await request.json() as Publication);
			return new Response(null, { status: 204 });
		}
		if (path === COORDINATOR_PATHS.readingSealed && request.method === 'POST') {
			return new Response(null, { status: await commitSealedReadingNote(env, await request.json() as SealedReadingNote) ? 204 : 409 });
		}
		if (path === COORDINATOR_PATHS.dispatchJobs && request.method === 'POST') {
			await drainNotificationJobs(env, undefined, request.headers.get(REMINDERS_ENABLED_HEADER) === '1' || undefined);
			return new Response(null, { status: 204 });
		}
		if (path === TRANSFER_PATHS.historyCheckpoint && request.method === 'GET') return getSharedCheckpoint(request, env.BUCKET);
		if (path === TRANSFER_PATHS.historyCheckpointFile && request.method === 'GET') return downloadCheckpointFile(request, env.BUCKET, env.DB);
		if (path === TRANSFER_PATHS.batchDownload && request.method === 'POST') return handleBatchDownload(request, env.BUCKET, env.DB);
		if (path === TRANSFER_PATHS.importUpload && ['POST', 'PUT'].includes(request.method)) {
			// One unpublished batch at a time bounds decoded attachment memory.
			return uploadInitialFiles(request, env.BUCKET, env.DB);
		}
		return await handleLockedCoordinatorRequest(request, state, env) ?? handleReminder();
	});
}

/** Internal endpoints; the caller holds the Durable Object's mutation lock. */
async function handleLockedCoordinatorRequest(request: Request, state: DurableObjectState, env: Env): Promise<Response | null> {
	if (request.headers.get(INTERNAL_MUTATION_HEADER) === '1') {
		const original = new Request(request);
		original.headers.delete(INTERNAL_MUTATION_HEADER);
		return fetchWorkerRequest(original, env, { kind: 'coordinator', state });
	}
	if (new URL(request.url).pathname === COORDINATOR_PATHS.maintain && request.method === 'POST') {
		await state.storage.put('maintenanceCoordinator', true);
		if (await state.storage.getAlarm() === null) {
			await state.storage.put('maintenancePass', 0);
			await state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
		}
		return new Response(null, { status: 204 });
	}
	if (new URL(request.url).pathname === COORDINATOR_PATHS.ensure && request.method === 'POST') {
		if (await state.storage.get<number>('projectionParserVersion') !== REMINDER_CACHE_PARSER_VERSION) {
			await armNotificationCoordinator(state);
			await state.storage.put('projectionParserVersion', REMINDER_CACHE_PARSER_VERSION);
		}
		return new Response(null, { status: 204 });
	}

	if (new URL(request.url).pathname === COORDINATOR_PATHS.project && request.method === 'POST') {
		await armNotificationCoordinator(state);
		return new Response(JSON.stringify({ success: true }));
	}

	return null;
}
