import type { Vault } from 'obsidian';
import { assertLocalSyncPath } from './local-path-safety';

export class LocalPathObstructionError extends Error {
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

export async function prepareLocalFilePath(vault: Vault, path: string): Promise<void> {
	assertLocalSyncPath(path);
	for (let end = path.indexOf('/'); end >= 0; end = path.indexOf('/', end + 1)) {
		const parent = path.slice(0, end);
		if ((await vault.adapter.stat(parent))?.type === 'file') throw new LocalPathObstructionError(parent, true);
	}
	if ((await vault.adapter.stat(path))?.type !== 'folder') return;
	try { await removeEmptyDirectory(vault, path); }
	catch { throw new LocalPathObstructionError(path); }
}
