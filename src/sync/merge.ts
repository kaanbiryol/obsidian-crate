/**
 * Line-based 3-way merge algorithm (diff3)
 * No external dependencies — uses LCS-based two-way diff internally.
 */

import type { MergeResult } from '../types';

const MAX_MERGE_LINES = 10_000;

interface DiffHunk {
	baseStart: number;
	baseCount: number;
	newStart: number;
	newCount: number;
}

/**
 * Two-way line diff using Longest Common Subsequence (O(n*m) DP).
 * Returns a list of hunks describing regions that differ between `a` and `b`.
 */
function diffLines(a: string[], b: string[]): DiffHunk[] {
	const n = a.length;
	const m = b.length;

	// Build LCS table
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			if (a[i - 1] === b[j - 1]) {
				dp[i]![j] = dp[i - 1]![j - 1]! + 1;
			} else {
				dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
			}
		}
	}

	// Back-trace to find matching pairs
	const matches: [number, number][] = [];
	let i = n;
	let j = m;
	while (i > 0 && j > 0) {
		if (a[i - 1] === b[j - 1]) {
			matches.push([i - 1, j - 1]);
			i--;
			j--;
		} else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
			i--;
		} else {
			j--;
		}
	}
	matches.reverse();

	// Convert matching pairs into diff hunks (the non-matching regions)
	const hunks: DiffHunk[] = [];
	let ai = 0;
	let bi = 0;

	for (const [ma, mb] of matches) {
		if (ai < ma || bi < mb) {
			hunks.push({
				baseStart: ai,
				baseCount: ma - ai,
				newStart: bi,
				newCount: mb - bi,
			});
		}
		ai = ma + 1;
		bi = mb + 1;
	}

	// Trailing diff after last match
	if (ai < n || bi < m) {
		hunks.push({
			baseStart: ai,
			baseCount: n - ai,
			newStart: bi,
			newCount: m - bi,
		});
	}

	return hunks;
}

/**
 * 3-way merge: merge local and remote changes against a common base.
 *
 * 1. Split all three versions into lines.
 * 2. Compute two-way diffs: base→local and base→remote.
 * 3. Walk both hunk lists aligned by base position:
 *    - No hunk at this region → copy base lines.
 *    - Only one side changed → take that change.
 *    - Both changed identically → take either.
 *    - Both changed differently → true conflict, return { success: false }.
 * 4. Return { success: true, merged } if clean.
 */
export function merge3(base: string, local: string, remote: string): MergeResult {
	const baseLines = base.split('\n');
	const localLines = local.split('\n');
	const remoteLines = remote.split('\n');

	// Guard: skip merge for very large files
	if (baseLines.length > MAX_MERGE_LINES ||
		localLines.length > MAX_MERGE_LINES ||
		remoteLines.length > MAX_MERGE_LINES) {
		return { success: false };
	}

	const localHunks = diffLines(baseLines, localLines);
	const remoteHunks = diffLines(baseLines, remoteLines);

	const result: string[] = [];
	let basePos = 0;
	let li = 0; // index into localHunks
	let ri = 0; // index into remoteHunks

	while (basePos <= baseLines.length) {
		const lh = li < localHunks.length ? localHunks[li]! : null;
		const rh = ri < remoteHunks.length ? remoteHunks[ri]! : null;

		// Determine the next hunk start
		const lStart = lh ? lh.baseStart : Infinity;
		const rStart = rh ? rh.baseStart : Infinity;
		const nextHunk = Math.min(lStart, rStart);

		if (nextHunk === Infinity) {
			// No more hunks — copy remaining base lines
			for (let k = basePos; k < baseLines.length; k++) {
				result.push(baseLines[k]!);
			}
			break;
		}

		// Copy base lines up to the next hunk
		for (let k = basePos; k < nextHunk; k++) {
			result.push(baseLines[k]!);
		}

		if (lh && rh && lStart === rStart) {
			// Both sides have a hunk at the same base position
			const lEnd = lh.baseStart + lh.baseCount;
			const rEnd = rh.baseStart + rh.baseCount;

			if (lEnd !== rEnd) {
				// Overlapping hunks with different base ranges — conflict
				return { success: false };
			}

			// Same base range — check if changes are identical
			const localNew = localLines.slice(lh.newStart, lh.newStart + lh.newCount);
			const remoteNew = remoteLines.slice(rh.newStart, rh.newStart + rh.newCount);

			if (localNew.length === remoteNew.length && localNew.every((line, idx) => line === remoteNew[idx])) {
				// Identical changes — take either
				result.push(...localNew);
			} else {
				// Different changes at same position — true conflict
				return { success: false };
			}

			basePos = lEnd;
			li++;
			ri++;
		} else if (lh && lStart <= rStart) {
			// Only local hunk (or local comes first)
			const lEnd = lh.baseStart + lh.baseCount;

			// Check for overlap with remote hunk
			if (rh && rh.baseStart < lEnd) {
				return { success: false };
			}

			const localNew = localLines.slice(lh.newStart, lh.newStart + lh.newCount);
			result.push(...localNew);
			basePos = lEnd;
			li++;
		} else if (rh) {
			// Only remote hunk (or remote comes first)
			const rEnd = rh.baseStart + rh.baseCount;

			// Check for overlap with local hunk
			if (lh && lh.baseStart < rEnd) {
				return { success: false };
			}

			const remoteNew = remoteLines.slice(rh.newStart, rh.newStart + rh.newCount);
			result.push(...remoteNew);
			basePos = rEnd;
			ri++;
		}
	}

	return { success: true, merged: result.join('\n') };
}
