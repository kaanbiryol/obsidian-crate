import { getPortablePathIssue, getSyncPathIssue } from '@/protocol/portable-path';

/** Leave room for a full UUID suffix within a portable 255-byte filename. */
function safeTitle(title: string): string {
	// eslint-disable-next-line no-control-regex -- Filenames cannot contain control characters.
	const clean = title.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*#[\]^]/gu, ' ').replace(/\s+/gu, ' ').trim();
	let result = '';
	for (const character of clean) {
		if (new TextEncoder().encode(result + character).length > 180) break;
		result += character;
	}
	return result.replace(/^[. ]+|[. ]+$/gu, '') || 'Article';
}

export async function readingCapturePath(folder: string, title: string, id: string, occupied: (path: string) => boolean | Promise<boolean>): Promise<string> {
	const hex = id.replace(/-/g, '').toLowerCase();
	if (!/^[a-f0-9]{32}$/.test(hex)) throw new Error('Invalid Reading ID.');
	for (let length = 8; length <= 32; length += 4) {
		let name = `${safeTitle(title)} - ${hex.slice(0, length)}.md`;
		if (getPortablePathIssue(name)) name = `Article ${name}`;
		const path = `${folder}/${name}`;
		if (getSyncPathIssue(path)) throw new Error('The Reading folder path is too long.');
		if (!await occupied(path)) return path;
	}
	throw new Error('A file already uses this Reading ID. Your saved link has been preserved.');
}
