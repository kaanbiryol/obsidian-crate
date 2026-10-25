import type { DataAdapter } from 'obsidian';
import type { FileEntry } from '../../protocol/sync-types';
import { sha256Hex } from '../../platform/sha256';

/** Writes a device-local checkpoint as earlier releases did. Only legacy history entries
 * still reference these. */
export async function writeLegacyCheckpoint(adapter: Pick<DataAdapter, 'exists' | 'mkdir' | 'write'>, root: string,
	authority: string, files: Record<string, FileEntry>, ignorePatterns: string[]): Promise<string> {
	const text = JSON.stringify({ version: 1, authority, ignorePatterns,
		files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) });
	const id = await sha256Hex(new TextEncoder().encode(text).buffer);
	if (!await adapter.exists(root)) await adapter.mkdir(root);
	await adapter.write(`${root}/${id}.json`, text);
	return id;
}
