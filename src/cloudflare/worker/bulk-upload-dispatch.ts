import { commitNewFiles, type NewFileUpload } from './bulk-new-file-commit';
import { armNotificationCoordinator } from './notification-lifecycle';
import type { Env } from './types';
import { isReminderPath } from './reminder-scope';
import { getNotificationPolicy } from './notification-policy';

export function coordinatedNewFiles(env: Env): typeof commitNewFiles {
  return async (bucket, db, files) => {
    if (!files.some(file => file.path.toLowerCase().endsWith('.md'))) return commitNewFiles(bucket, db, files);
    const metadata = files.map(({ content: _content, ...file }) => file);
    const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
    const response = await stub.fetch('https://do/commit-new-files', { method: 'POST', body: JSON.stringify(metadata) });
    if (!response.ok) throw new Error('Bulk upload commit is uncertain; retry the same operations');
    return response.json() as Promise<Awaited<ReturnType<typeof commitNewFiles>>>;
  };
}

/** Read staged bytes before acquiring the reminder coordinator's state lock. */
export async function prepareCoordinatedNewFiles(request: Request, env: Env): Promise<NewFileUpload[]> {
  const metadata = await request.json() as Omit<NewFileUpload, 'content'>[];
  const policy = await getNotificationPolicy(env.DB);
  const files: NewFileUpload[] = [];
  for (let offset = 0; offset < metadata.length; offset += 3) {
    files.push(...await Promise.all(metadata.slice(offset, offset + 3).map(async file => {
      file.reminderPolicyRevision = policy?.revision ?? null;
      if (!isReminderPath(file.path, policy?.folderPath ?? null)) return { ...file, content: new ArrayBuffer(0) };
      const object = await env.BUCKET.get(file.objectKey);
      if (!object) throw new Error('Staged object unavailable');
      return { ...file, content: await object.arrayBuffer() };
    })));
  }
  return files;
}

export async function commitCoordinatedNewFiles(files: NewFileUpload[], state: DurableObjectState, env: Env): Promise<Response> {
  const policyRevision = (await getNotificationPolicy(env.DB))?.revision ?? null;
  if (files.some(file => file.reminderPolicyRevision !== undefined && file.reminderPolicyRevision !== policyRevision)) {
    return Response.json({ error: 'Reminder folder changed during upload. Retry the upload.' }, { status: 503 });
  }
  await armNotificationCoordinator(state);
  return Response.json(await commitNewFiles(env.BUCKET, env.DB, files));
}
