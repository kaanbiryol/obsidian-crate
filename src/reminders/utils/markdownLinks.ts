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

/** Notification surfaces display labels without exposing Markdown destinations. */
export function readableLinkText(content: string): string {
    let result = content;
    for (const link of parseMarkdownLinks(content).reverse()) {
        result = result.slice(0, link.index) + (link.text || link.url) + result.slice(link.index + link.fullMatch.length);
    }
    return result;
}
