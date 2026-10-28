import type { Vault } from 'obsidian';
import { portablePathKey } from '../../protocol/portable-path';

/**
 * `adapter.exists()` on a case-insensitive or Unicode-normalizing file system
 * (macOS, iOS, Windows) also matches a stored variant of a file name, such as
 * `TODO.md` for `todo.md`. This is false when the parent folder's listing shows
 * such a variant stored instead of the name itself. Any other listing, including
 * a failed one, keeps the adapter's answer, so a path is never reported absent
 * without seeing the name that replaced it. Folder names are not compared: such
 * a device keeps one folder for every spelling, and the files inside it remain.
 */
export async function localPathExists(vault: Vault, path: string): Promise<boolean> {
	if (!await vault.adapter.exists(path)) return false;
	// Obsidian indexes visible files and folders by their exact stored names.
	return Boolean(vault.getAbstractFileByPath(path)) || !await storedAsVariant(vault, path);
}

async function storedAsVariant(vault: Vault, path: string): Promise<boolean> {
	const slash = path.lastIndexOf('/');
	const name = path.slice(slash + 1);
	let listing: { files: string[]; folders: string[] };
	try { listing = await vault.adapter.list(slash < 0 ? '' : path.slice(0, slash)); }
	catch { return false; }
	const names = [...listing.files, ...listing.folders].map(child => child.slice(child.lastIndexOf('/') + 1));
	if (names.includes(name)) return false;
	const key = portablePathKey(name);
	return names.some(other => portablePathKey(other) === key);
}
