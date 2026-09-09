export class MarkdownEncodingError extends Error {
	constructor() {
		super('Save this note as UTF-8 without null characters before editing its reminders. The original vault file remains synced.');
		this.name = 'MarkdownEncodingError';
	}
}

/** Keep BOMs and reject substitutions: reminder edits must preserve unrelated bytes. */
export function decodeMarkdownBytes(bytes: ArrayBuffer | Uint8Array): string {
	let text: string;
	try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
	catch { throw new MarkdownEncodingError(); }
	if (text.includes('\0')) throw new MarkdownEncodingError();
	return text;
}
