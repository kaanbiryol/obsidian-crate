import { transcriptSegments, type TranscriptSegment } from '../core/transcript';

/** Decorate trusted parser output without changing visible text or highlight offsets. */
export function decorateTranscript(content: DocumentFragment, markdown: string, segments: TranscriptSegment[] = transcriptSegments(markdown)): void {
	const walker = content.ownerDocument.createTreeWalker(content, 4);
	const nodes: { node: Node; start: number; end: number }[] = [];
	let offset = 0;
	while (walker.nextNode()) {
		const node = walker.currentNode, start = offset;
		offset += node.textContent?.length ?? 0; nodes.push({ node, start, end: offset });
	}
	let index = 0;
	for (const segment of segments) {
		while (index < nodes.length && nodes[index]!.end <= segment.start) index++;
		const node = nodes[index]?.node;
		const paragraph = node?.parentElement?.closest('p,li');
		const timestamp = paragraph?.querySelector('strong,a');
		if (!paragraph || !timestamp || timestamp.textContent?.trim() !== segment.label) continue;
		paragraph.setAttribute('data-transcript-seconds', String(segment.seconds));
		timestamp.setAttribute('data-transcript-seek', String(segment.seconds));
		timestamp.setAttribute('role', 'button'); timestamp.setAttribute('tabindex', '0');
		timestamp.setAttribute('aria-label', `Seek to ${segment.label}`);
	}
}
