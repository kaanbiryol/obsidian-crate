import { commitNewFiles, type NewFileUpload } from './bulk-new-file-commit';
import { armNotificationCoordinator } from '../../notifications/lifecycle';
import type { Env } from '../../types';
import { getNotificationPolicy } from '../../notifications/policy';
import { FRAMED_CONTENT_HEADER, frameUpload, hasFramedMarkdown, readFrame } from './staged-upload-dispatch';
import { createsNotificationWork, needsStagedReminderBytes, policyFenceRefusal, readCommitFolders } from './commit-context';
import { commitCoordinatorNewFiles } from '../../coordinator/coordinator';
import { isMarkdownPath } from '../../../../protocol/note-paths';

/** Small Markdown bytes, and every encrypted note, travel with the request: an encrypted
 * reminder note is projected from its public data. */
const framesContent = (file: Pick<NewFileUpload, 'path' | 'size' | 'encryptionState'>) =>
	hasFramedMarkdown(file) || Boolean(file.encryptionState) && isMarkdownPath(file.path);

export function coordinatedNewFiles(env: Env): typeof commitNewFiles {
	return async (bucket, db, files) => {
		if (!files.some(file => isMarkdownPath(file.path))) return commitNewFiles(bucket, db, files);
		const metadata = files.map(({ content: _content, ...file }) => file);
		// Framed bytes follow the metadata in order, so the coordinator need not read
		// them back from R2.
		const body = frameUpload(metadata, files.filter(framesContent).map(file => file.content));
		const response = await commitCoordinatorNewFiles(env, { body, headers: { [FRAMED_CONTENT_HEADER]: '1' } });
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
	for (const file of framed ? metadata.filter(framesContent) : []) {
		attached.set(file, framed!.content.slice(position, position + file.size));
		position += file.size;
	}
	if (framed && position !== framed.content.byteLength) throw new Error('Staged upload size mismatch');
	// Files with framed bytes need no policy fence; only the rest decide what to read from R2.
	const policy = metadata.some(file => !attached.has(file)) ? await getNotificationPolicy(env.DB) : null;
	const files: NewFileUpload[] = [];
	for (let offset = 0; offset < metadata.length; offset += 3) {
		files.push(...await Promise.all(metadata.slice(offset, offset + 3).map(async file => {
			const content = attached.get(file);
			if (content) return { ...file, content };
			file.reminderPolicyRevision = policy?.revision ?? null;
			if (!needsStagedReminderBytes(file, policy?.folderPath ?? null)) return { ...file, content: new ArrayBuffer(0) };
			const object = await env.BUCKET.get(file.objectKey);
			if (!object) throw new Error('Staged object unavailable');
			return { ...file, content: await object.arrayBuffer() };
		})));
	}
	return files;
}

export async function commitCoordinatedNewFiles(files: NewFileUpload[], state: DurableObjectState, env: Env): Promise<Response> {
	// One read under the lock covers the policy fence and the folders used by the
	// reminder projection and the Reading index.
	const current = await readCommitFolders(env.DB);
	const refused = policyFenceRefusal(files.map(file => file.reminderPolicyRevision), current);
	if (refused) return refused;
	if (createsNotificationWork(files.map(file => file.path), current)) await armNotificationCoordinator(state);
	return Response.json(await commitNewFiles(env.BUCKET, env.DB, files, current.reminderFolder, current.readingPolicy));
}
