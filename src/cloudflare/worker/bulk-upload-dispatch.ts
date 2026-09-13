import { commitNewFiles, type NewFileUpload } from './bulk-new-file-commit';
import { armNotificationCoordinator } from './notification-lifecycle';
import type { Env } from './types';

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
  const files: NewFileUpload[] = [];
  for (let offset = 0; offset < metadata.length; offset += 3) {
    files.push(...await Promise.all(metadata.slice(offset, offset + 3).map(async file => {
      const object = await env.BUCKET.get(file.objectKey);
      if (!object) throw new Error('Staged object unavailable');
      return { ...file, content: await object.arrayBuffer() };
    })));
  }
  return files;
}

export async function commitCoordinatedNewFiles(files: NewFileUpload[], state: DurableObjectState, env: Env): Promise<Response> {
  await armNotificationCoordinator(state);
  return Response.json(await commitNewFiles(env.BUCKET, env.DB, files));
}
