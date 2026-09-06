import type { TFile, Vault } from 'obsidian';
import { createConflictCopy } from './conflict';
import { isHiddenPath } from './file-discovery';
import { computeHash } from './hasher';
import { isMarkdownPath } from './markdown-base-cache';
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

	return applySnapshot(context.vault, path, content, snapshot);
}

export async function preserveLocalVersionsAndApplyRemote(
	context: LocalApplyContext,
	path: string,
	initialLocalContent: ArrayBuffer,
	remoteContent: ArrayBuffer,
	onConflictCopy?: (copy: CreatedConflictCopy) => Promise<void>,
): Promise<DiffApplyOutcome> {
	await ensureParentFolder(context.vault, path);
	let localContent = initialLocalContent;
	let localHash = await computeHash(localContent);

	for (let attempt = 0; attempt < MAX_CONFLICT_COPY_ATTEMPTS; attempt++) {
		const conflictPath = await createConflictCopy(context.vault, path, localContent);
		await onConflictCopy?.({ path: conflictPath, hash: localHash });
		const latest = await readLocalSnapshot(context.vault, path);
		if (!latest.exists || latest.hash === localHash) {
			return applySnapshot(context.vault, path, remoteContent, latest);
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

export async function writeRemoteContent(
	context: LocalApplyContext,
	path: string,
	content: ArrayBuffer,
): Promise<void> {
	await ensureParentFolder(context.vault, path);
	const snapshot = await readLocalSnapshot(context.vault, path);
	await writeLocalContent(context.vault, path, content, snapshot);
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
	vault: Vault,
	path: string,
	content: ArrayBuffer,
	snapshot: LocalSnapshot,
): Promise<void> {
	if (isMarkdownPath(path) && snapshot.content) {
		let expectedText: string;
		let replacement: string;
		try {
			expectedText = textDecoder.decode(snapshot.content);
			replacement = textDecoder.decode(content);
		} catch {
			// Non-UTF-8 files still transfer byte-for-byte through the binary path.
			return writeBinaryContent(vault, path, content, snapshot);
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
	await writeBinaryContent(vault, path, content, snapshot);
}

async function applySnapshot(vault: Vault, path: string, content: ArrayBuffer, snapshot: LocalSnapshot): Promise<DiffApplyOutcome> {
	try {
		await writeLocalContent(vault, path, content, snapshot);
		return { status: 'applied' };
	} catch (error) {
		if (error instanceof LocalFileChangedError) return { status: 'deferred', reason: error.message };
		throw error;
	}
}

async function writeBinaryContent(vault: Vault, path: string, content: ArrayBuffer, snapshot: LocalSnapshot): Promise<void> {
	if (isHiddenPath(path) || (snapshot.exists && !snapshot.visibleFile)) {
		await vault.adapter.writeBinary(path, content);
		return;
	}
	if (snapshot.visibleFile) {
		await vault.modifyBinary(snapshot.visibleFile, content);
		return;
	}
	await vault.createBinary(path, content);
}
