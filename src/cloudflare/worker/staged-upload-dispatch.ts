import { getStoredFileRow } from './sync-storage';
import { commitStagedFile } from './sync-mutations';
import { armNotificationCoordinator } from './notification-lifecycle';
import { FileNamespaceConflictError } from './file-namespace';
import type { Env } from './types';
import { isReminderPath } from './reminder-scope';
import { getNotificationPolicy } from './notification-policy';
import { readEncryptionState } from './encryption-state';
import type { UploadCommitInput, UploadCommitters } from './upload-committers';

type UploadParams = UploadCommitInput;
type CommitUpload = UploadCommitters['commitUpload'];
// Explicit fields keep local-only commit options out of the JSON transport.
type UploadMetadata = Pick<UploadParams,
  'path' | 'hash' | 'size' | 'objectKey' | 'expectedHash' | 'expectedRevision'
  | 'previousFile' | 'encryptionState' | 'resetGeneration' | 'operation'>;

/** File transfer and hashing finish before acquiring the coordinator lock. */
export function coordinatedUpload(env: Env): CommitUpload {
  return async (bucket, db, params) => {
    if (!params.path.toLowerCase().endsWith('.md')) return commitStagedFile(bucket, db, params);
    const metadata: UploadMetadata = {
      path: params.path, hash: params.hash, size: params.size, objectKey: params.objectKey,
      expectedHash: params.expectedHash, expectedRevision: params.expectedRevision,
      previousFile: params.previousFile, encryptionState: params.encryptionState,
      resetGeneration: params.resetGeneration, operation: params.operation,
    };
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
  const metadata = await request.json() as UploadMetadata & { reminderPolicyRevision?: string | null };
  const policy = await getNotificationPolicy(env.DB);
  metadata.reminderPolicyRevision = policy?.revision ?? null;
  if (!isReminderPath(metadata.path, policy?.folderPath ?? null) && !await readEncryptionState(env.DB)) return { ...metadata, content: new ArrayBuffer(0) };
  const object = await env.BUCKET.get(metadata.objectKey);
  if (!object) return Response.json({ error: 'Staged object unavailable' }, { status: 503 });
  const content = await object.arrayBuffer();
  return { ...metadata, content };
}

export async function commitCoordinatedUpload(params: UploadParams, state: DurableObjectState, env: Env): Promise<Response> {
  if (params.reminderPolicyRevision !== undefined && params.reminderPolicyRevision !== ((await getNotificationPolicy(env.DB))?.revision ?? null)) {
    return Response.json({ error: 'Reminder folder changed during upload. Retry the upload.' }, { status: 503 });
  }
  const previousFile = await getStoredFileRow(env.DB, params.path);
  await armNotificationCoordinator(state);
  try {
    return Response.json(await commitStagedFile(env.BUCKET, env.DB, { ...params, previousFile }));
  } catch (error) {
    if (error instanceof FileNamespaceConflictError) return error.toResponse();
    throw error;
  }
}
