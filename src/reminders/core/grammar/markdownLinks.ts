const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\(([^)]*)\)/g;

export interface ParsedMarkdownLink {
	fullMatch: string;
	text: string;
	url: string;
	index: number;
}

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'obsidian:']);

export function parseMarkdownLinks(content: string): ParsedMarkdownLink[] {
	const links: ParsedMarkdownLink[] = [];
	const regex = new RegExp(MARKDOWN_LINK_REGEX.source, MARKDOWN_LINK_REGEX.flags);
	let match;
	while ((match = regex.exec(content)) !== null) {
		links.push({
			fullMatch: match[0],
			text: match[1] ?? '',
			url: match[2] ?? '',
			index: match.index,
		});
	}
	for (const direct of content.matchAll(/\bhttps?:\/\/[^\s<>[\]"`]+/gi)) {
		if (links.some(link => direct.index >= link.index && direct.index < link.index + link.fullMatch.length)) continue;
		let url = direct[0].replace(/[.,!?;:]+$/, '');
		while (url.endsWith(')') && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) url = url.slice(0, -1);
		if (isSafeUrl(url)) links.push({ fullMatch: url, text: url, url, index: direct.index });
	}
	return links.sort((a, b) => a.index - b.index);
}

export function isSafeUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return SAFE_PROTOCOLS.has(parsed.protocol);
	} catch {
		// Relative URLs or malformed - reject
		return false;
	}
}

/** Display note links without changing the stored reminder or external link targets. */
export function readableWikiLinks(content: string): string {
	return content.replace(/\[\[([^\]\n[]+)\]\]/g, (_match, target: string) => {
		const [path = '', alias] = target.split('|');
		if (alias?.trim()) return alias.trim();
		const [note = '', heading] = path.split('#');
		const title = (note.split('/').pop() || '').replace(/\.md$/i, '');
		return heading ? [title, heading].filter(Boolean).join(' › ') : title;
	});
}

/** Notification surfaces display reminder text as reminder cards do: link labels
 * and readable note links, without exposing Markdown destinations. */
export function readableLinkText(content: string): string {
	let result = '';
	let lastIndex = 0;
	for (const link of parseMarkdownLinks(content)) {
		result += readableWikiLinks(content.slice(lastIndex, link.index)) + (link.text || link.url);
		lastIndex = link.index + link.fullMatch.length;
	}
	return result + readableWikiLinks(content.slice(lastIndex));
}
