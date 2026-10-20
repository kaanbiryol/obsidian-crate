import { toFileStorageRow } from './storage';
import { filePathArgs } from './file-identity';
import { commitStagedFile } from './mutations';
import { armNotificationCoordinator } from '../notifications/lifecycle';
import { FileNamespaceConflictError } from './file-namespace';
import type { Env } from '../types';
import { isReminderPath } from '../reminders/scope';
import { getNotificationPolicy } from '../notifications/policy';
import { readEncryptionState } from '../encryption/state';
import type { UploadCommitInput, UploadCommitters } from './upload-committers';
import { commitCoordinatorUpload } from '../coordinator/coordinator';

type UploadParams = UploadCommitInput;
type CommitUpload = UploadCommitters['commitUpload'];
// Explicit fields keep local-only commit options out of the JSON transport.
type UploadMetadata = Pick<UploadParams,
  'path' | 'hash' | 'size' | 'objectKey' | 'expectedHash' | 'expectedRevision'
  | 'previousFile' | 'encryptionState' | 'resetGeneration' | 'operation'>;

// Markdown commits carry their bytes, framed after the metadata, so the
// coordinator validates and projects them without reading the staged object
// back from R2. Large plaintext files keep the metadata-only request.
export const FRAMED_CONTENT_HEADER = 'X-Crate-Framed-Content';
const FRAMED_MARKDOWN_MAX_BYTES = 1024 * 1024;

export function hasFramedMarkdown(file: { path: string; size: number }): boolean {
  return file.path.toLowerCase().endsWith('.md') && file.size <= FRAMED_MARKDOWN_MAX_BYTES;
}

export function frameUpload(metadata: unknown, contents: Array<string | ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const head = new TextEncoder().encode(JSON.stringify(metadata));
  const parts = contents.map(content => typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content));
  const frame = new Uint8Array(4 + head.length + parts.reduce((total, part) => total + part.length, 0));
  new DataView(frame.buffer).setUint32(0, head.length);
  frame.set(head, 4);
  let offset = 4 + head.length;
  for (const part of parts) {
    frame.set(part, offset);
    offset += part.length;
  }
  return frame;
}

export function readFrame<T>(frame: ArrayBuffer): { metadata: T; content: ArrayBuffer } {
  const length = new DataView(frame).getUint32(0);
  return { metadata: JSON.parse(new TextDecoder().decode(new Uint8Array(frame, 4, length))) as T, content: frame.slice(4 + length) };
}

type CoordinatedUploadMetadata = UploadMetadata & { reminderPolicyRevision?: string | null };

async function readUpload(request: Request): Promise<{ metadata: CoordinatedUploadMetadata; content?: ArrayBuffer }> {
  if (request.headers.get(FRAMED_CONTENT_HEADER) !== '1') return { metadata: await request.json() as CoordinatedUploadMetadata };
  return readFrame<CoordinatedUploadMetadata>(await request.arrayBuffer());
}

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
    const response = await commitCoordinatorUpload(env, params.encryptionState || hasFramedMarkdown(params)
      ? { body: frameUpload(metadata, [params.content]), headers: { [FRAMED_CONTENT_HEADER]: '1' } }
      : { body: JSON.stringify(metadata) });
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
  const { metadata, content: framed } = await readUpload(request);
  const policy = await getNotificationPolicy(env.DB);
  metadata.reminderPolicyRevision = policy?.revision ?? null;
  if (framed) {
    if (framed.byteLength !== metadata.size) return Response.json({ error: 'Staged upload size mismatch' }, { status: 400 });
    return { ...metadata, content: framed };
  }
  if (!isReminderPath(metadata.path, policy?.folderPath ?? null) && !await readEncryptionState(env.DB)) return { ...metadata, content: new ArrayBuffer(0) };
  const object = await env.BUCKET.get(metadata.objectKey);
  if (!object) return Response.json({ error: 'Staged object unavailable' }, { status: 503 });
  const content = await object.arrayBuffer();
  return { ...metadata, content };
}

export async function commitCoordinatedUpload(params: UploadParams, state: DurableObjectState, env: Env): Promise<Response> {
  // One read under the lock covers the policy fence, the previous file and the
  // folder used by the projection enqueue.
  const current = await env.DB.prepare(`SELECT p.revision, p.folder_path, f.hash, f.size, f.storage_key
    FROM (SELECT 1) LEFT JOIN notification_policy p ON p.id = 1
    LEFT JOIN files f ON f.portable_path = ? AND f.path = ?`).bind(...filePathArgs(params.path))
    .first<{ revision: string | null; folder_path: string | null; hash: string | null; size: number | null; storage_key: string | null }>();
  if (params.reminderPolicyRevision !== undefined && params.reminderPolicyRevision !== (current?.revision ?? null)) {
    return Response.json({ error: 'Reminder folder changed during upload. Retry the upload.' }, { status: 503 });
  }
  const previousFile = toFileStorageRow(current);
  await armNotificationCoordinator(state);
  try {
    return Response.json(await commitStagedFile(env.BUCKET, env.DB, { ...params, previousFile, reminderFolder: current?.folder_path ?? null }));
  } catch (error) {
    if (error instanceof FileNamespaceConflictError) return error.toResponse();
    throw error;
  }
}
