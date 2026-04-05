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
    return links;
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
