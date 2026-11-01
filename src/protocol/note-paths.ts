/** A path ending in `.md`, in any letter case, is a Markdown note everywhere in Crate. */
export function isMarkdownPath(path: string): boolean {
	return path.toLowerCase().endsWith('.md');
}

/** Any path below `folder`, never the folder itself. The path is compared as
 * given, so callers validate or normalize it first. */
export function isPathInFolder(path: string, folder: string): boolean {
	return path.startsWith(`${folder}/`);
}

/** A Markdown note anywhere below `folder`, never the folder itself. The path is
 * compared as given, so callers validate or normalize it first. */
export function isMarkdownNoteInFolder(path: string, folder: string): boolean {
	return isPathInFolder(path, folder) && isMarkdownPath(path);
}
