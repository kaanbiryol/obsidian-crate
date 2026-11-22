const MARKER = /\s*<!-- crate-done:([^>]*?) -->/g;

/** A completion time is stored as a UTC ISO instant, exactly as `toISOString` writes it. */
export function isCompletionInstant(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** Removes every completion marker, returning the first valid time. */
export function readCompletionMetadata(content: string): { content: string; completedAt?: string } {
	let completedAt: string | undefined;
	const stripped = content.replace(MARKER, (_marker, value: string) => {
		if (!completedAt && isCompletionInstant(value)) completedAt = value;
		return '';
	});
	return { content: stripped, completedAt };
}

export function appendCompletionMetadata(content: string, completedAt?: string): string {
	return completedAt ? `${content} <!-- crate-done:${completedAt} -->` : content;
}

/** Replaces a line's completion marker, keeping a CRLF line's carriage return. */
export function setCompletionMarker(line: string, completedAt: string | undefined): string {
	const cr = line.endsWith('\r') ? '\r' : '';
	const { content } = readCompletionMetadata(cr ? line.slice(0, -1) : line);
	return `${appendCompletionMetadata(content.trimEnd(), completedAt)}${cr}`;
}
