import type { TFile, Vault } from 'obsidian';
import { createConflictCopy } from './conflict';
import { isHiddenPath } from './file-discovery';
import { computeHash } from './hasher';
import { IncomingFileReviewError, preserveIncomingForReview } from './incoming-file-review';
import type { RecordConflictInput } from './conflict-store';
import { isVaultTFileLike } from './planner-helpers';
import type { DiffApplyOutcome } from './transfer-types';

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

const TEXT_PATH = /\.(?:md|txt|canvas|json|jsonc|css|scss|js|mjs|cjs|ts|tsx|jsx|svg|xml|html|csv|tsv|yaml|yml|toml|ini|excalidraw)$/i;

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
	await ensureParentFolder(context.vault, path);
	if (!TEXT_PATH.test(path)) {
		return applySnapshot(context, path, remoteContent, await readLocalSnapshot(context.vault, path));
	}
	let localContent = initialLocalContent;
	let localHash = await computeHash(localContent);

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
			hash: await computeHash(content),
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
	if (TEXT_PATH.test(path) && snapshot.content) {
		let expectedText: string;
		let replacement: string;
		try {
			expectedText = textDecoder.decode(snapshot.content);
			replacement = textDecoder.decode(content);
		} catch {
			return preserveIncomingForReview(context, path, content, snapshot.hash ?? '');
		}
		const update = (current: string): string => {
			if (current !== expectedText) throw new LocalFileChangedError();
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
	if (snapshot.exists || isHiddenPath(path)) {
		return preserveIncomingForReview(context, path, content, snapshot.hash ?? '');
	}
	// Vault.createBinary refuses an existing visible path, including a create
	// that races our earlier snapshot. Never fall back to an overwriting write.
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
