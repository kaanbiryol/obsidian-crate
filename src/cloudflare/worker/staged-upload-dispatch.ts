import { getStoredFileRow } from './sync-storage';
import { commitStagedFile } from './sync-mutations';
import { armNotificationCoordinator } from './notification-lifecycle';
import { FileNamespaceConflictError } from './file-namespace';
import type { Env } from './types';

type UploadParams = Parameters<typeof commitStagedFile>[2];
export type CommitUpload = typeof commitStagedFile;

/** File transfer and hashing finish before acquiring the coordinator lock. */
export function coordinatedUpload(env: Env): CommitUpload {
  return async (bucket, db, params) => {
    if (!params.path.toLowerCase().endsWith('.md')) return commitStagedFile(bucket, db, params);
    const { content: _content, ...metadata } = params;
    const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
    const response = await stub.fetch('https://do/commit-upload', { method: 'POST', body: JSON.stringify(metadata) });
    if (!response.ok) {
      const failure = await response.json() as { code?: string; path?: string; conflictingPath?: string };
      if (failure.code === 'namespace_conflict') throw new FileNamespaceConflictError(failure.path!, failure.conflictingPath!);
      throw new Error('Staged upload could not be committed; retry the same operation');
    }
    return response.json() as Promise<Awaited<ReturnType<CommitUpload>>>;
  };
}

export async function prepareCoordinatedUpload(request: Request, env: Env): Promise<UploadParams | Response> {
  // Only the authenticated Worker calls this internal DO endpoint. No public route exposes it.
  const metadata = await request.json() as Omit<UploadParams, 'content'>;
  const object = await env.BUCKET.get(metadata.objectKey);
  if (!object) return Response.json({ error: 'Staged object unavailable' }, { status: 503 });
  const content = await object.arrayBuffer();
  return { ...metadata, content };
}

export async function commitCoordinatedUpload(params: UploadParams, state: DurableObjectState, env: Env): Promise<Response> {
  const previousFile = await getStoredFileRow(env.DB, params.path);
  await armNotificationCoordinator(state);
  try {
    return Response.json(await commitStagedFile(env.BUCKET, env.DB, { ...params, previousFile }));
  } catch (error) {
    if (error instanceof FileNamespaceConflictError) return error.toResponse();
    throw error;
  }
}
