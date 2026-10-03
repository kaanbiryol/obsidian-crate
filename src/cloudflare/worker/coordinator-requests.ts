import { armNotificationCoordinator } from './notification-lifecycle';
import { fetchWorkerRequest } from './request-handler';
import { REMINDER_CACHE_PARSER_VERSION } from './reminders-web/reminder-cache/types';
import type { Env } from './types';

import { publishExtraction, type Publication } from './reading/extraction/jobs';
import { createSharedCheckpoint, getSharedCheckpoint, downloadCheckpointFile } from './history-checkpoints';
import { drainNotificationJobs } from './notification-outbox';
import { uploadInitialFiles } from './initial-import-upload';
import { handleBatchDownload } from './sync-batch/download';
import { prepareCoordinatedNewFiles, commitCoordinatedNewFiles } from './bulk-upload-dispatch';
import { prepareCoordinatedUpload, commitCoordinatedUpload } from './staged-upload-dispatch';

export type StateLock = <T>(action: () => Promise<T>) => Promise<T>;

/** Preparation may read large bodies; only publication and state changes hold the lock. */
export async function handleCoordinatorRequest(
  request: Request, state: DurableObjectState, env: Env,
  withStateLock: StateLock, handleReminder: () => Promise<Response>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if ((path === '/sync-upload' && request.method === 'PUT') || (path === '/sync-batch-upload' && request.method === 'POST')) {
    // Reauthenticate inside the transfer queue so reset/revocation fences waiting writers.
    const target = new URL(request.url);
    target.pathname = path === '/sync-upload' ? '/sync/upload' : '/sync/batch-upload';
    return withStateLock(() => fetchWorkerRequest(new Request(target, request), env, undefined, true));
  }
  if (path === '/commit-new-files' && request.method === 'POST') {
    const prepared = await prepareCoordinatedNewFiles(request, env);
    return withStateLock(() => commitCoordinatedNewFiles(prepared, state, env));
  }
  if (path === '/commit-upload' && request.method === 'POST') {
    const prepared = await prepareCoordinatedUpload(request, env);
    if (prepared instanceof Response) return prepared;
    return withStateLock(() => commitCoordinatedUpload(prepared, state, env));
  }
  return withStateLock(async () => {
    if (path === '/reading-wake' && request.method === 'POST') {
      await state.storage.put('readingCoordinator', true);
      if (await state.storage.getAlarm() === null) await state.storage.setAlarm(Date.now() + 100);
      return new Response(null, { status: 204 });
    }
    if (path === '/reading-publish' && request.method === 'POST') {
      await publishExtraction(env, await request.json() as Publication);
      return new Response(null, { status: 204 });
    }
    if (path === '/dispatch-jobs' && request.method === 'POST') {
      await drainNotificationJobs(env);
      return new Response(null, { status: 204 });
    }
    if (path === '/history-checkpoint-create' && request.method === 'POST') return createSharedCheckpoint(env.BUCKET, env.DB);
    if (path === '/history-checkpoint' && request.method === 'GET') return getSharedCheckpoint(request, env.BUCKET);
    if (path === '/history-checkpoint-file' && request.method === 'GET') return downloadCheckpointFile(request, env.BUCKET, env.DB);
    if (path === '/batch-download' && request.method === 'POST') return handleBatchDownload(request, env.BUCKET, env.DB);
    if (path === '/import-upload' && ['POST', 'PUT'].includes(request.method)) {
      // One unpublished batch at a time bounds decoded attachment memory.
      return uploadInitialFiles(request, env.BUCKET, env.DB);
    }
    return await handleLockedCoordinatorRequest(request, state, env) ?? handleReminder();
  });
}

/** Internal endpoints; the caller holds the Durable Object's mutation lock. */
async function handleLockedCoordinatorRequest(request: Request, state: DurableObjectState, env: Env): Promise<Response | null> {
	if (request.headers.get('X-Crate-Internal-Mutation') === '1') {
		const maintenance = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/maintenance'));
		const response = await maintenance.fetch('https://do/maintain', { method: 'POST' });
		if (!response.ok) throw new Error('Unable to schedule server cleanup');
		const original = new Request(request);
		original.headers.delete('X-Crate-Internal-Mutation');
		return fetchWorkerRequest(original, env, state);
	}
	if (new URL(request.url).pathname === '/maintain' && request.method === 'POST') {
		await state.storage.put('maintenanceCoordinator', true);
		if (await state.storage.getAlarm() === null) {
      await state.storage.put('maintenancePass', 0);
      await state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    }
		return new Response(null, { status: 204 });
	}
	if (new URL(request.url).pathname === '/ensure' && request.method === 'POST') {
		if (await state.storage.get<number>('projectionParserVersion') !== REMINDER_CACHE_PARSER_VERSION) {
			await armNotificationCoordinator(state);
			await state.storage.put('projectionParserVersion', REMINDER_CACHE_PARSER_VERSION);
		}
		return new Response(null, { status: 204 });
	}

	if (new URL(request.url).pathname === '/project' && request.method === 'POST') {
		await armNotificationCoordinator(state);
		return new Response(JSON.stringify({ success: true }));
	}

  return null;
}
