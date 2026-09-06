export interface ChangeHunk {
	start: number;
	end: number;
	replacement: string[];
}

interface Anchor {
	baseIndex: number;
	targetIndex: number;
}

export function diffSequence(baseLines: string[], targetLines: string[]): ChangeHunk[] {
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
