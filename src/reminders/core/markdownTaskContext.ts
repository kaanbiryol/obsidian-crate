export interface MarkdownTaskContext {
	lineNumber: number;
	indentation: number;
}

export class ReminderMarkdownContextError extends Error {}

function indentationWidth(whitespace: string): number {
	let width = 0;
	for (const character of whitespace) width += character === '\t' ? 4 - width % 4 : 1;
	return width;
}

/** Shared task eligibility for adoption, reads, ownership checks and writes. */
export function markdownTaskContexts(lines: readonly string[]): Map<number, MarkdownTaskContext> {
	const tasks = new Map<number, MarkdownTaskContext>();
	const containers: number[] = [];
	let fence: { character: string; length: number } | undefined;
	const htmlTags: string[] = [];
	let htmlComment = false;
	const trackHtmlTags = (line: string) => {
		for (const match of line.matchAll(/<!--|-->|<(\/?)(pre|script|style|textarea|div|table|details)(?:\s[^>]*|)>/gi)) {
			if (match[0] === '<!--') { htmlComment = true; continue; }
			if (match[0] === '-->') { htmlComment = false; continue; }
			if (htmlComment) continue;
			const tag = match[2]!.toLowerCase();
			if (!match[1]) htmlTags.push(tag);
			else if (htmlTags[htmlTags.length - 1] === tag) htmlTags.pop();
		}
	};
	let comment = false;
	let frontmatter = false;
	for (const [lineNumber, line] of lines.entries()) {
		const trimmed = line.trim();
		if (lineNumber === 0 && trimmed === '---') { frontmatter = true; continue; }
		if (frontmatter) {
			if (trimmed === '---' || trimmed === '...') frontmatter = false;
			continue;
		}
		if (comment) {
			if (line.includes('-->')) comment = false;
			continue;
		}
		if (htmlTags.length) {
			trackHtmlTags(line);
			continue;
		}
		if (fence) {
			const close = trimmed.match(/^(`+|~+)\s*$/)?.[1];
			if (close?.[0] === fence.character && close.length >= fence.length) fence = undefined;
			continue;
		}
		if (!trimmed) continue;
		const whitespace = line.match(/^[ \t]*/)?.[0] ?? '';
		const indentation = indentationWidth(whitespace);
		while (containers.length && indentation < containers[containers.length - 1]!) containers.pop();
		const base = containers[containers.length - 1] ?? 0;
		// Four extra spaces form code; ordinary nested list items retain their
		// parent container's indentation instead of being mistaken for code.
		if (indentation >= base + 4) continue;
		const body = line.slice(whitespace.length);
		const list = body.match(/^(?:[-+*]|\d+[.)])([ \t]+)/);
		if (list) containers.push(indentation + indentationWidth(list[0]));
		const containerBody = list ? body.slice(list[0].length) : body;
		const openingFence = containerBody.match(/^(`{3,}|~{3,})(.*)$/);
		if (openingFence && !(openingFence[1]![0] === '`' && openingFence[2]!.includes('`'))) {
			fence = { character: openingFence[1]![0]!, length: openingFence[1]!.length };
			continue;
		}
		if (containerBody.startsWith('<!--')) {
			comment = !containerBody.includes('-->');
			continue;
		}
		const html = containerBody.match(/^<(pre|script|style|textarea|div|table|details)(?:\s|>)/i);
		if (html) {
			trackHtmlTags(containerBody);
			continue;
		}
		if (/^-\s*\[[ xX]\]\s*/.test(body)) tasks.set(lineNumber, { lineNumber, indentation });
		const commentStart = body.lastIndexOf('<!--');
		if (commentStart > body.lastIndexOf('-->')) comment = true;
	}
	return tasks;
}

/** A checkbox-only removal or move must not detach its children or prose. */
export function hasAttachedMarkdownContent(lines: readonly string[], lineNumber: number, endLine: number): boolean {
	const indentation = indentationWidth(lines[lineNumber]?.match(/^[ \t]*/)?.[0] ?? '');
	let separated = false;
	for (let index = endLine; index < lines.length; index++) {
		const line = lines[index]!;
		if (!line.trim()) { separated = true; continue; }
		const nextIndentation = indentationWidth(line.match(/^[ \t]*/)?.[0] ?? '');
		if (nextIndentation > indentation) return true;
		if (separated || /^(?:[ \t]*[-+*]\s|[ \t]*\d+[.)]\s|[ \t]*#{1,6}\s|[ \t]*[`~]{3}|[ \t]*<!--)/.test(line)) return false;
		return true;
	}
	return false;
}
