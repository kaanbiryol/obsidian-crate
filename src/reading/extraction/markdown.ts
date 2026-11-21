import { createMarkdownContent } from 'defuddle/full';

/** Crate validates content; Defuddle owns every HTML-to-Markdown formatting rule. */
export function articleMarkdown(body: HTMLElement, base: string): string {
	const pending: { node: Element; depth: number }[] = [{ node: body, depth: 0 }];
	while (pending.length) {
		const { node, depth } = pending.pop()!;
		if (depth > 100) throw new Error('Article nesting is too deep');
		for (const child of Array.from(node.children)) pending.push({ node: child, depth: depth + 1 });
	}
	// Reading saves text and images, not other media or executable embeds.
	for (const element of Array.from(body.querySelectorAll('script,style,iframe,object,embed,form,svg,video,audio,input,button,noscript,template'))) element.remove();
	// Inline data images would bloat the note; Defuddle falls back to a lazy-loading source.
	for (const image of Array.from(body.querySelectorAll('img[src]'))) if (/^\s*data:/i.test(image.getAttribute('src')!)) image.removeAttribute('src');
	for (const link of Array.from(body.querySelectorAll('a[href]'))) {
		try {
			const url = new URL(link.getAttribute('href')!, base);
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe link');
			link.setAttribute('href', url.href);
		} catch { link.removeAttribute('href'); }
	}
	const markdown = createMarkdownContent(body.innerHTML, base);
	// Defuddle reports conversion failure as a string containing the original HTML.
	// Never publish that fallback as a successfully extracted article.
	if (markdown.startsWith('Partial conversion completed with errors. Original HTML:')) throw new Error('Article Markdown conversion failed');
	return markdown;
}
