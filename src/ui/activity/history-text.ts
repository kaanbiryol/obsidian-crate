import type { DiffLine } from './diff-model';

/** Keep internal IDs intact for copying and comparison, but visually secondary. */
export function renderFileText(container: HTMLElement, text: string, words?: DiffLine['words']): void {
	const markers = [...text.matchAll(/<!--\s*crate-id:[^\r\n]*?-->/g)].map(match => ({ start: match.index, end: match.index + match[0].length }));
	let offset = 0;
	const changes = (words ?? []).flatMap(word => {
		const start = offset; offset += word.text.length;
		return word.changed ? [{ start, end: offset }] : [];
	});
	const boundaries = [...new Set([0, text.length, ...[...markers, ...changes].flatMap(range => [range.start, range.end])])].sort((a, b) => a - b);
	for (let i = 0; i < boundaries.length - 1; i++) {
		const start = boundaries[i]!, end = boundaries[i + 1]!;
		const cls = [
			markers.some(range => start >= range.start && start < range.end) ? 'crate-history-internal-marker' : '',
			changes.some(range => start >= range.start && start < range.end) ? 'crate-diff-word' : '',
		].filter(Boolean).join(' ');
		container.createSpan({ cls, text: text.slice(start, end) });
	}
}
