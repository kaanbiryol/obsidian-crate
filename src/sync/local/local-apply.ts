import type { TFile, Vault } from 'obsidian';
import { createConflictCopy, getIncomingConflictFileName } from '../conflict/conflict';
import { isHiddenPath } from './file-discovery';
import type { RecordConflictInput } from '../conflict/store';
import { isVaultTFileLike } from './local-delete';
import type { DiffApplyOutcome } from '../transfer/types';
import { isCurrentVaultFile } from './vault-file-identity';
import { sha256Hex } from '../../platform/sha256';
import { assertLocalSyncPath } from './local-path-safety';
import { isUtf8Text } from '../history/preview-format';

class LocalPathObstructionError extends Error {
	constructor(readonly path: string, readonly isParent = false) {
		super(isParent
			? `A local file blocks the folder ${path}. Preserve or move that file, then sync again.`
			: `The local folder ${path} contains files or could not be removed. Preserve or move its contents, then sync again.`);
	}
}

/** Only empty directories may be removed. The non-recursive host operation is
 * the final guard against a child being created after our directory listing. */
async function removeEmptyDirectory(vault: Vault, path: string): Promise<void> {
	const children = await vault.adapter.list(path);
	if (children.files.length) throw new LocalPathObstructionError(path);
	for (const child of children.folders) await removeEmptyDirectory(vault, child);
	await vault.adapter.rmdir(path, false);
}

async function prepareLocalFilePath(vault: Vault, path: string): Promise<void> {
	assertLocalSyncPath(path);
	for (let end = path.indexOf('/'); end >= 0; end = path.indexOf('/', end + 1)) {
		const parent = path.slice(0, end);
		if ((await vault.adapter.stat(parent))?.type === 'file') throw new LocalPathObstructionError(parent, true);
	}
	if ((await vault.adapter.stat(path))?.type !== 'folder') return;
	try { await removeEmptyDirectory(vault, path); }
	catch { throw new LocalPathObstructionError(path); }
}

class IncomingFileReviewError extends Error {}

const INCOMING_REVIEW_REASON = 'This file needs manual review because it cannot be replaced atomically.';

export function incomingReviewMessage(copy: string, reason = INCOMING_REVIEW_REASON): string {
	return `${reason} Incoming file saved at ${copy}. Review both versions and replace the original when ready`;
}

/** Preserve incoming bytes without replacing a path lacking an atomic writer. */
async function preserveIncomingForReview(
	context: { vault: Vault; conflictStore?: { record(input: RecordConflictInput): Promise<void> } },
	path: string,
	content: ArrayBuffer,
	localHash: string,
	reason = INCOMING_REVIEW_REASON,
): Promise<never> {
	const hash = await sha256Hex(content);
	let copy = getIncomingConflictFileName(path, hash);
	for (let variant = 0; await context.vault.adapter.exists(copy); variant++) {
		if (await sha256Hex(await context.vault.adapter.readBinary(copy)) === hash) break;
		if (variant >= 100) throw new IncomingFileReviewError('Too many edited incoming copies. Review them before syncing this file again.');
		copy = getIncomingConflictFileName(path, hash, variant + 1);
	}
	if (!await context.vault.adapter.exists(copy)) {
		// A concurrent creator or an edited recovery copy must never be overwritten,
		// including hidden paths. The host may return null for an unindexed file.
		await context.vault.createBinary(copy, content);
	}
	await context.conflictStore?.record({ originalPath: path, conflictPath: copy, cause: 'incoming-review', copySide: 'remote', localHash, remoteHash: hash });
	throw new IncomingFileReviewError(incomingReviewMessage(copy, reason));
}

const MAX_CONFLICT_COPY_ATTEMPTS = 3;
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class LocalFileChangedError extends Error {
	constructor() {
		super('Local file changed before the remote version could be written');
	}
}

interface LocalSnapshot {
	exists: boolean;
	content?: ArrayBuffer;
	hash?: string;
	visibleFile?: TFile;
}

interface LocalApplyContext {
	vault: Vault;
	conflictStore?: { record(input: RecordConflictInput): Promise<void> };
}

interface CreatedConflictCopy {
	path: string;
	hash: string;
}

export async function applyRemoteContentIfUnchanged(
	context: LocalApplyContext,
	path: string,
	content: ArrayBuffer,
	expectedLocalHash: string | null,
): Promise<DiffApplyOutcome> {
	const obstruction = await preparePath(context, path, content);
	if (obstruction) return obstruction;
	await ensureParentFolder(context.vault, path);
	const snapshot = await readLocalSnapshot(context.vault, path);
	const matchesPlan = expectedLocalHash === null
		? !snapshot.exists
		: snapshot.hash === expectedLocalHash;
	if (!matchesPlan) {
		return {
			status: 'deferred',
			reason: 'Local file changed while the remote version was downloading',
		};
	}

	return applySnapshot(context, path, content, snapshot);
}

export async function preserveLocalVersionsAndApplyRemote(
	context: LocalApplyContext,
	path: string,
	initialLocalContent: ArrayBuffer,
	remoteContent: ArrayBuffer,
	onConflictCopy?: (copy: CreatedConflictCopy) => Promise<void>,
): Promise<DiffApplyOutcome> {
	const obstruction = await preparePath(context, path, remoteContent);
	if (obstruction) return obstruction;
	await ensureParentFolder(context.vault, path);
	if (!isUtf8Text(path, initialLocalContent) || !isUtf8Text(path, remoteContent)) {
		return applySnapshot(context, path, remoteContent, await readLocalSnapshot(context.vault, path));
	}
	let localContent = initialLocalContent;
	let localHash = await sha256Hex(localContent);

	for (let attempt = 0; attempt < MAX_CONFLICT_COPY_ATTEMPTS; attempt++) {
		const conflictPath = await createConflictCopy(context.vault, path, localContent);
		await onConflictCopy?.({ path: conflictPath, hash: localHash });
		const latest = await readLocalSnapshot(context.vault, path);
		if (!latest.exists || latest.hash === localHash) {
			return applySnapshot(context, path, remoteContent, latest);
		}

		if (!latest.content || !latest.hash) {
			break;
		}
		localContent = latest.content;
		localHash = latest.hash;
	}

	return {
		status: 'deferred',
		reason: 'Local file kept changing while its conflict copy was being created',
	};
}

async function preparePath(context: LocalApplyContext, path: string, content: ArrayBuffer): Promise<DiffApplyOutcome | undefined> {
	try { await prepareLocalFilePath(context.vault, path); }
	catch (error) {
		if (!(error instanceof LocalPathObstructionError)) throw error;
		if (error.isParent) return { status: 'deferred', reason: error.message };
		try { await preserveIncomingForReview(context, path, content, '', error.message); }
		catch (copyError) {
			if (!(copyError instanceof IncomingFileReviewError)) throw copyError;
			return { status: 'deferred', reason: copyError.message };
		}
	}
	return undefined;
}

async function readLocalSnapshot(vault: Vault, path: string): Promise<LocalSnapshot> {
	const abstractFile = vault.getAbstractFileByPath(path);
	const visibleFile = isVaultTFileLike(abstractFile) ? abstractFile : undefined;
	const adapterExists = visibleFile !== undefined || await vault.adapter.exists(path);
	if (!adapterExists) return { exists: false };

	try {
		const content = await vault.adapter.readBinary(path);
		return {
			exists: true,
			content,
			hash: await sha256Hex(content),
			...(visibleFile ? { visibleFile } : {}),
		};
	} catch (error) {
		if (!await vault.adapter.exists(path)) return { exists: false };
		throw error;
	}
}

async function ensureParentFolder(vault: Vault, path: string): Promise<void> {
	const folderPath = path.substring(0, path.lastIndexOf('/'));
	if (!folderPath) return;

	if (isHiddenPath(path)) {
		try {
			await vault.adapter.mkdir(folderPath);
		} catch {
			// Folder already exists.
		}
		return;
	}

	try {
		await vault.createFolder(folderPath);
	} catch {
		// Folder already exists.
	}
}

async function writeLocalContent(
	context: LocalApplyContext,
	path: string,
	content: ArrayBuffer,
	snapshot: LocalSnapshot,
): Promise<void> {
	const { vault } = context;
	if (snapshot.content && isUtf8Text(path, snapshot.content) && isUtf8Text(path, content)) {
		const expectedText = textDecoder.decode(snapshot.content);
		const replacement = textDecoder.decode(content);
		const update = (current: string): string => {
			if (current !== expectedText || snapshot.visibleFile && !isCurrentVaultFile(vault, path, snapshot.visibleFile)) throw new LocalFileChangedError();
			return replacement;
		};
		// Compare within the atomic callback, after all asynchronous hashing and
		// network work. Throwing also prevents an unchanged write on a mismatch.
		if (snapshot.visibleFile && !isHiddenPath(path)) {
			await vault.process(snapshot.visibleFile, update);
		} else {
			await vault.adapter.process(path, update);
		}
		return;
	}
	if (snapshot.exists) {
		return preserveIncomingForReview(context, path, content, snapshot.hash ?? '');
	}
	// createBinary checks adapter.exists for hidden paths too. Its return value
	// can be null for unindexed files; only the completed write matters here.
	// Never fall back to an overwriting write if the host rejects creation.
	await vault.createBinary(path, content);
}

async function applySnapshot(context: LocalApplyContext, path: string, content: ArrayBuffer, snapshot: LocalSnapshot): Promise<DiffApplyOutcome> {
	try {
		await writeLocalContent(context, path, content, snapshot);
		return { status: 'applied' };
	} catch (error) {
		if (error instanceof LocalFileChangedError || error instanceof IncomingFileReviewError) return { status: 'deferred', reason: error.message };
		throw error;
	}
}
