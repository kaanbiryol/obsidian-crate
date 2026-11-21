import { requestUrl, TFile, TFolder, type Vault } from 'obsidian';
import type { CapturedArticle } from './core/article';
import { downloadArticleImages, linkSavedImages, type ReadingImageFetch } from './core/article-images';

const TIMEOUT_MS = 20_000;

/** Obsidian's HTTP client bypasses CORS and sends no vault credentials. */
const fetchImage: ReadingImageFetch = async (url, maxBytes, signal) => {
	let timeout: number | undefined;
	try {
		const response = await Promise.race([
			// Servers that honor Range send at most one byte over the limit.
			requestUrl({ url, method: 'GET', throw: false, headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif', Range: `bytes=0-${maxBytes}` } }),
			new Promise<never>((_resolve, reject) => { timeout = window.setTimeout(() => reject(new Error('Image download timed out')), TIMEOUT_MS); }),
		]);
		signal.throwIfAborted();
		if (response.status === 206) {
			// A partial response is complete only when its range reaches the end of the image.
			const header = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-range')?.[1] ?? '';
			const range = /^bytes 0-(\d+)\/(\d+)$/i.exec(header);
			if (!range || Number(range[1]) + 1 !== Number(range[2])) return null;
		} else if (response.status !== 200) return null;
		return response.arrayBuffer.byteLength > maxBytes ? null : new Uint8Array(response.arrayBuffer);
	} finally { window.clearTimeout(timeout); }
};

async function ensureFolder(vault: Vault, directory: string): Promise<void> {
	const segments = directory.split('/');
	for (let i = 1; i <= segments.length; i++) {
		const part = segments.slice(0, i).join('/');
		if (vault.getAbstractFileByPath(part)) continue;
		try { await vault.createFolder(part); } catch (error) { if (!(vault.getAbstractFileByPath(part) instanceof TFolder)) throw error; }
	}
}

/**
 * Saves an article's images into the vault and returns the article pointing at the copies.
 * Images are written before the note, so the note never links to a file that is not there yet;
 * an image that could not be stored keeps its web link.
 */
export async function saveDesktopArticleImages(article: CapturedArticle, options: {
	vault: Vault; folder: string; id: string; signal: AbortSignal; allowed: (path: string) => boolean;
}): Promise<CapturedArticle> {
	const { vault, signal } = options;
	const files = await downloadArticleImages(article.markdown, { folder: options.folder, id: options.id, fetchImage, signal });
	const stored = [];
	for (const file of files) {
		signal.throwIfAborted();
		if (!options.allowed(file.path)) break;
		try {
			await ensureFolder(vault, file.path.slice(0, file.path.lastIndexOf('/')));
			const bytes = file.bytes.slice().buffer, existing = vault.getAbstractFileByPath(file.path);
			// A retried download replaces the copy an earlier attempt left.
			if (existing instanceof TFile) await vault.modifyBinary(existing, bytes);
			else if (existing) continue;
			else await vault.createBinary(file.path, bytes);
			stored.push(file);
		} catch { /* The image keeps its web link. */ }
	}
	return stored.length ? { ...article, markdown: linkSavedImages(article.markdown, options.folder, stored) } : article;
}
