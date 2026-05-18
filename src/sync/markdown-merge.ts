export interface MarkdownMergeSuccess {
	success: true;
	content: ArrayBuffer;
	text: string;
}

export interface MarkdownMergeConflict {
	success: false;
	reason: 'decode' | 'overlap' | 'too-large';
}

export type MarkdownMergeResult = MarkdownMergeSuccess | MarkdownMergeConflict;

interface ChangeHunk {
	start: number;
	end: number;
	replacement: string[];
}

interface Anchor {
	baseIndex: number;
	targetIndex: number;
}

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

	const localHunks = diffLines(baseLines, localLines);
	const remoteHunks = diffLines(baseLines, remoteLines);
	const mergedLines = mergeHunks(baseLines, localHunks, remoteHunks);
	if (!mergedLines) {
		return { success: false, reason: 'overlap' };
	}

	const mergedText = joinLines(
		mergedLines,
		hasFinalNewline(localText),
		detectEol(localText),
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

function diffLines(baseLines: string[], targetLines: string[]): ChangeHunk[] {
	const hunks: ChangeHunk[] = [];
	diffRegion(baseLines, targetLines, 0, baseLines.length, 0, targetLines.length, hunks);
	return hunks;
}

function diffRegion(
	baseLines: string[],
	targetLines: string[],
	baseStart: number,
	baseEnd: number,
	targetStart: number,
	targetEnd: number,
	hunks: ChangeHunk[],
): void {
	while (
		baseStart < baseEnd
		&& targetStart < targetEnd
		&& baseLines[baseStart] === targetLines[targetStart]
	) {
		baseStart++;
		targetStart++;
	}

	while (
		baseStart < baseEnd
		&& targetStart < targetEnd
		&& baseLines[baseEnd - 1] === targetLines[targetEnd - 1]
	) {
		baseEnd--;
		targetEnd--;
	}

	if (baseStart === baseEnd && targetStart === targetEnd) {
		return;
	}

	const anchors = findPatienceAnchors(
		baseLines,
		targetLines,
		baseStart,
		baseEnd,
		targetStart,
		targetEnd,
	);

	if (anchors.length === 0) {
		hunks.push({
			start: baseStart,
			end: baseEnd,
			replacement: targetLines.slice(targetStart, targetEnd),
		});
		return;
	}

	let previousBase = baseStart;
	let previousTarget = targetStart;
	for (const anchor of anchors) {
		diffRegion(
			baseLines,
			targetLines,
			previousBase,
			anchor.baseIndex,
			previousTarget,
			anchor.targetIndex,
			hunks,
		);
		previousBase = anchor.baseIndex + 1;
		previousTarget = anchor.targetIndex + 1;
	}

	diffRegion(
		baseLines,
		targetLines,
		previousBase,
		baseEnd,
		previousTarget,
		targetEnd,
		hunks,
	);
}

function findPatienceAnchors(
	baseLines: string[],
	targetLines: string[],
	baseStart: number,
	baseEnd: number,
	targetStart: number,
	targetEnd: number,
): Anchor[] {
	const baseOccurrences = countOccurrences(baseLines, baseStart, baseEnd);
	const targetOccurrences = countOccurrences(targetLines, targetStart, targetEnd);
	const candidateAnchors: Anchor[] = [];

	for (let index = baseStart; index < baseEnd; index++) {
		const line = baseLines[index] ?? '';
		const baseOccurrence = baseOccurrences.get(line);
		const targetOccurrence = targetOccurrences.get(line);
		if (
			baseOccurrence?.count === 1
			&& targetOccurrence?.count === 1
			&& targetOccurrence.index !== undefined
		) {
			candidateAnchors.push({
				baseIndex: index,
				targetIndex: targetOccurrence.index,
			});
		}
	}

	return longestIncreasingSubsequence(candidateAnchors);
}

function countOccurrences(
	lines: string[],
	start: number,
	end: number,
): Map<string, { count: number; index?: number }> {
	const occurrences = new Map<string, { count: number; index?: number }>();
	for (let index = start; index < end; index++) {
		const line = lines[index] ?? '';
		const current = occurrences.get(line);
		if (current) {
			current.count++;
			current.index = undefined;
		} else {
			occurrences.set(line, { count: 1, index });
		}
	}
	return occurrences;
}

function longestIncreasingSubsequence(anchors: Anchor[]): Anchor[] {
	if (anchors.length <= 1) {
		return anchors;
	}

	const tails: number[] = [];
	const previous = new Array<number>(anchors.length).fill(-1);

	for (let index = 0; index < anchors.length; index++) {
		const targetIndex = anchors[index]?.targetIndex ?? 0;
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			const tailAnchor = anchors[tails[middle] ?? 0];
			if ((tailAnchor?.targetIndex ?? 0) < targetIndex) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}

		if (low > 0) {
			previous[index] = tails[low - 1] ?? -1;
		}
		tails[low] = index;
	}

	const sequence: Anchor[] = [];
	let cursor = tails[tails.length - 1] ?? -1;
	while (cursor !== -1) {
		const anchor = anchors[cursor];
		if (anchor) {
			sequence.push(anchor);
		}
		cursor = previous[cursor] ?? -1;
	}

	return sequence.reverse();
}

function mergeHunks(
	baseLines: string[],
	localHunks: ChangeHunk[],
	remoteHunks: ChangeHunk[],
): string[] | null {
	const merged: string[] = [];
	let baseIndex = 0;
	let localIndex = 0;
	let remoteIndex = 0;

	while (localIndex < localHunks.length || remoteIndex < remoteHunks.length) {
		const localHunk = localHunks[localIndex];
		const remoteHunk = remoteHunks[remoteIndex];

		if (!localHunk) {
			appendBaseAndHunk(merged, baseLines, baseIndex, remoteHunk);
			baseIndex = remoteHunk.end;
			remoteIndex++;
			continue;
		}

		if (!remoteHunk) {
			appendBaseAndHunk(merged, baseLines, baseIndex, localHunk);
			baseIndex = localHunk.end;
			localIndex++;
			continue;
		}

		if (sameRange(localHunk, remoteHunk) && sameLines(localHunk.replacement, remoteHunk.replacement)) {
			appendBaseAndHunk(merged, baseLines, baseIndex, localHunk);
			baseIndex = localHunk.end;
			localIndex++;
			remoteIndex++;
			continue;
		}

		if (isSamePointInsertion(localHunk, remoteHunk)) {
			merged.push(...baseLines.slice(baseIndex, localHunk.start));
			merged.push(...localHunk.replacement, ...remoteHunk.replacement);
			baseIndex = localHunk.start;
			localIndex++;
			remoteIndex++;
			continue;
		}

		if (localHunk.end <= remoteHunk.start) {
			appendBaseAndHunk(merged, baseLines, baseIndex, localHunk);
			baseIndex = localHunk.end;
			localIndex++;
			continue;
		}

		if (remoteHunk.end <= localHunk.start) {
			appendBaseAndHunk(merged, baseLines, baseIndex, remoteHunk);
			baseIndex = remoteHunk.end;
			remoteIndex++;
			continue;
		}

		return null;
	}

	merged.push(...baseLines.slice(baseIndex));
	return merged;
}

function appendBaseAndHunk(
	merged: string[],
	baseLines: string[],
	baseIndex: number,
	hunk: ChangeHunk,
): void {
	merged.push(...baseLines.slice(baseIndex, hunk.start));
	merged.push(...hunk.replacement);
}

function sameRange(left: ChangeHunk, right: ChangeHunk): boolean {
	return left.start === right.start && left.end === right.end;
}

function isSamePointInsertion(left: ChangeHunk, right: ChangeHunk): boolean {
	return left.start === left.end
		&& right.start === right.end
		&& left.start === right.start;
}

function sameLines(left: string[], right: string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	return left.every((line, index) => line === right[index]);
}
