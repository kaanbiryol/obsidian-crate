import type { Vault } from 'obsidian';
import type { LocalManifest } from './manifest';
import { readLocalFileEntry } from './local-file-entry';
import { getSyncPathIssue } from '@/protocol/portable-path';
import { isRecord } from '@/plugin/settings';

export function parseRenameDependencies(value: unknown): Map<string, string> {
	if (value === undefined) return new Map();
	if (!isRecord(value)) throw new Error('Invalid rename checkpoint. Preserve sync metadata before resetting.');
	for (const [source, destination] of Object.entries(value)) {
		if (getSyncPathIssue(source) || typeof destination !== 'string' || getSyncPathIssue(destination)) throw new Error('Invalid rename checkpoint. Preserve sync metadata before resetting.');
	}
	return new Map(Object.entries(value) as Array<[string, string]>);
}

export async function assertRenamePreserved(manifest: LocalManifest, vault: Vault, path: string): Promise<void> {
	if (manifest.uploadJournal.pending().length) throw new Error('Remote deletion deferred until pending uploads are resolved. The previous remote copies are preserved.');
	const destination = manifest.renameDestination(path);
	if (!destination) return;
	const saved = manifest.getEntry(destination);
	const local = await readLocalFileEntry(vault, destination);
	if (!saved?.revision || !local || saved.hash !== local.hash) throw new Error(`Remote deletion deferred until the renamed file is uploaded: ${destination}`);
	// Persist the acknowledgement before the old copy can be deleted.
	await manifest.save();
}
