import { diffSequence } from './text-diff';
import { mergeSequences } from './text-merge';
import { createInlineMerger } from './markdown-inline-merge';

interface MarkdownMergeSuccess {
	success: true;
	content: ArrayBuffer;
	text: string;
}

interface MarkdownMergeConflict {
	success: false;
	reason: 'decode' | 'overlap' | 'too-large';
}

type MarkdownMergeResult = MarkdownMergeSuccess | MarkdownMergeConflict;

const MAX_MERGE_LINES = 20_000;

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

export function mergeMarkdownContent(
	baseContent: ArrayBuffer,
	localContent: ArrayBuffer,
	remoteContent: ArrayBuffer,
): MarkdownMergeResult {
	let baseText: string;
	let localText: string;
	let remoteText: string;
	try {
		baseText = decodeUtf8(baseContent);
		localText = decodeUtf8(localContent);
		remoteText = decodeUtf8(remoteContent);
	} catch {
		return { success: false, reason: 'decode' };
	}

	const baseLines = splitNormalizedLines(baseText);
	const localLines = splitNormalizedLines(localText);
	const remoteLines = splitNormalizedLines(remoteText);
	if (
		baseLines.length > MAX_MERGE_LINES
		|| localLines.length > MAX_MERGE_LINES
		|| remoteLines.length > MAX_MERGE_LINES
	) {
		return { success: false, reason: 'too-large' };
	}

	const localHunks = diffSequence(baseLines, localLines);
	const remoteHunks = diffSequence(baseLines, remoteLines);
	const mergedLines = mergeSequences(baseLines, localHunks, remoteHunks, {
		mergeOverlap: createInlineMerger(baseLines),
	});
	if (!mergedLines) {
		return { success: false, reason: 'overlap' };
	}

	const mergedText = joinLines(
		mergedLines,
		hasFinalNewline(baseText),
		detectEol(baseText),
	);

	return {
		success: true,
		text: mergedText,
		content: encodeUtf8(mergedText),
	};
}

function decodeUtf8(content: ArrayBuffer): string {
	return decoder.decode(new Uint8Array(content));
}

function encodeUtf8(text: string): ArrayBuffer {
	const bytes = encoder.encode(text);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function detectEol(text: string): string {
	const match = /\r\n|\n|\r/.exec(text);
	if (!match || match[0] === '\r') {
		return '\n';
	}
	return match[0];
}

function normalizeNewlines(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function hasFinalNewline(text: string): boolean {
	const normalized = normalizeNewlines(text);
	return normalized.endsWith('\n');
}

function splitNormalizedLines(text: string): string[] {
	const normalized = normalizeNewlines(text);
	if (normalized.length === 0) {
		return [];
	}

	const lines = normalized.split('\n');
	if (normalized.endsWith('\n')) {
		lines.pop();
	}
	return lines;
}

function joinLines(lines: string[], finalNewline: boolean, eol: string): string {
	const text = `${lines.join('\n')}${finalNewline ? '\n' : ''}`;
	return eol === '\n' ? text : text.replace(/\n/g, eol);
}
