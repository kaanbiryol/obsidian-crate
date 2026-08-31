import type { TFile, Vault } from 'obsidian';
import { createConflictCopy } from './conflict';
import { isHiddenPath } from './file-discovery';
import { computeHash } from './hasher';
import { isVaultTFileLike } from './transfer-prepare';
import type { DiffApplyOutcome } from './transfer-types';

const MAX_CONFLICT_COPY_ATTEMPTS = 3;

interface LocalSnapshot {
	exists: boolean;
	content?: ArrayBuffer;
	hash?: string;
	visibleFile?: TFile;
}

interface LocalApplyContext {
	vault: Vault;
}

export type ConflictPreservingApplyOutcome = DiffApplyOutcome & { conflictPaths: string[] };

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

	await writeLocalContent(context.vault, path, content, snapshot);
	return { status: 'applied' };
}

export async function preserveLocalVersionsAndApplyRemote(
	context: LocalApplyContext,
	path: string,
	initialLocalContent: ArrayBuffer,
	remoteContent: ArrayBuffer,
): Promise<ConflictPreservingApplyOutcome> {
	await ensureParentFolder(context.vault, path);
	const conflictPaths: string[] = [];
	let localContent = initialLocalContent;
	let localHash = await computeHash(localContent);

	for (let attempt = 0; attempt < MAX_CONFLICT_COPY_ATTEMPTS; attempt++) {
		conflictPaths.push(await createConflictCopy(context.vault, path, localContent));
		const latest = await readLocalSnapshot(context.vault, path);
		if (!latest.exists || latest.hash === localHash) {
			await writeLocalContent(context.vault, path, remoteContent, latest);
			return { status: 'applied', conflictPaths };
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
		conflictPaths,
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
