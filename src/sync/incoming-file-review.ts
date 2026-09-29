import type { Vault } from 'obsidian';
import { getIncomingConflictFileName } from './conflict';
import { computeHash } from './hasher';
import type { RecordConflictInput } from './conflict-store';

export class IncomingFileReviewError extends Error {}

/** Preserve incoming bytes without replacing a path lacking an atomic writer. */
export async function preserveIncomingForReview(
	context: { vault: Vault; conflictStore?: { record(input: RecordConflictInput): Promise<void> } },
	path: string,
	content: ArrayBuffer,
	localHash: string,
	reason = 'This file needs manual review because it cannot be replaced atomically.',
): Promise<never> {
	const hash = await computeHash(content);
	let copy = getIncomingConflictFileName(path, hash);
	for (let variant = 0; await context.vault.adapter.exists(copy); variant++) {
		if (await computeHash(await context.vault.adapter.readBinary(copy)) === hash) break;
		if (variant >= 100) throw new IncomingFileReviewError('Too many edited incoming copies. Review them before syncing this file again.');
		copy = getIncomingConflictFileName(path, hash, variant + 1);
	}
	if (!await context.vault.adapter.exists(copy)) {
		// A concurrent creator or an edited recovery copy must never be overwritten,
		// including hidden paths. The host may return null for an unindexed file.
		await context.vault.createBinary(copy, content);
	}
	await context.conflictStore?.record({ originalPath: path, conflictPath: copy, cause: 'incoming-review', copySide: 'remote', localHash, remoteHash: hash });
	throw new IncomingFileReviewError(`${reason} Incoming file saved at ${copy}. Review both versions and replace the original when ready`);
}
