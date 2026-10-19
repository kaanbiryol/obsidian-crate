import { commitNewFiles, type NewFileUpload } from './bulk-new-file-commit';
import { armNotificationCoordinator } from '../notifications/lifecycle';
import type { Env } from '../types';
import { isReminderPath } from '../reminders/scope';
import { getNotificationPolicy } from '../notifications/policy';
import { FRAMED_CONTENT_HEADER, frameUpload, hasFramedMarkdown, readFrame } from './staged-upload-dispatch';

export function coordinatedNewFiles(env: Env): typeof commitNewFiles {
  return async (bucket, db, files) => {
    if (!files.some(file => file.path.toLowerCase().endsWith('.md'))) return commitNewFiles(bucket, db, files);
    const metadata = files.map(({ content: _content, ...file }) => file);
    // Small Markdown bytes follow the metadata in order, so the coordinator need
    // not read them back from R2.
    const body = frameUpload(metadata, files.filter(hasFramedMarkdown).map(file => file.content));
    const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
    const response = await stub.fetch('https://do/commit-new-files', { method: 'POST', body, headers: { [FRAMED_CONTENT_HEADER]: '1' } });
    if (!response.ok) throw new Error('Bulk upload commit is uncertain; retry the same operations');
    return response.json() as Promise<Awaited<ReturnType<typeof commitNewFiles>>>;
  };
}

/** Read staged bytes before acquiring the reminder coordinator's state lock. */
export async function prepareCoordinatedNewFiles(request: Request, env: Env): Promise<NewFileUpload[]> {
  type Metadata = Omit<NewFileUpload, 'content'>[];
  const framed = request.headers.get(FRAMED_CONTENT_HEADER) === '1' ? readFrame<Metadata>(await request.arrayBuffer()) : null;
  const metadata = framed ? framed.metadata : await request.json() as Metadata;
  const attached = new Map<Metadata[number], ArrayBuffer>();
  let position = 0;
  for (const file of framed ? metadata.filter(hasFramedMarkdown) : []) {
    attached.set(file, framed!.content.slice(position, position + file.size));
    position += file.size;
  }
  if (framed && position !== framed.content.byteLength) throw new Error('Staged upload size mismatch');
  const policy = await getNotificationPolicy(env.DB);
  const files: NewFileUpload[] = [];
  for (let offset = 0; offset < metadata.length; offset += 3) {
    files.push(...await Promise.all(metadata.slice(offset, offset + 3).map(async file => {
      file.reminderPolicyRevision = policy?.revision ?? null;
      const content = attached.get(file);
      if (content) return { ...file, content };
      if (!isReminderPath(file.path, policy?.folderPath ?? null)) return { ...file, content: new ArrayBuffer(0) };
      const object = await env.BUCKET.get(file.objectKey);
      if (!object) throw new Error('Staged object unavailable');
      return { ...file, content: await object.arrayBuffer() };
    })));
  }
  return files;
}

export async function commitCoordinatedNewFiles(files: NewFileUpload[], state: DurableObjectState, env: Env): Promise<Response> {
  const policy = await getNotificationPolicy(env.DB);
  if (files.some(file => file.reminderPolicyRevision !== undefined && file.reminderPolicyRevision !== (policy?.revision ?? null))) {
    return Response.json({ error: 'Reminder folder changed during upload. Retry the upload.' }, { status: 503 });
  }
  await armNotificationCoordinator(state);
  return Response.json(await commitNewFiles(env.BUCKET, env.DB, files, policy?.folderPath ?? null));
}
