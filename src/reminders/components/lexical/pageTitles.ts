import { createContext } from 'react';

export type PageTitleResolver = (url: string) => Promise<string | null>;
export const PageTitleContext = createContext<PageTitleResolver | undefined>(undefined);
/** Decode only text entities, and keep titles compatible with the reminder Markdown parser. */
export function normalizePageTitle(title: string, document: Document): string | null {
	const Parser = document.defaultView?.DOMParser;
	if (!Parser) return null;
	const text = new Parser().parseFromString(`<body>${title.replace(/</g, '&lt;')}`, 'text/html').body.textContent ?? '';
	const normalized = text.replace(/\s+/g, ' ').replace(/\[/g, '［').replace(/\]/g, '］')
		.replace(/\\/g, '＼').trim();
	return Array.from(normalized).slice(0, 256).join('') || null;
}
