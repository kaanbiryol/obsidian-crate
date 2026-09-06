import type { ChangeHunk } from './text-diff';

export function mergeSequences(
	baseLines: string[],
	localHunks: ChangeHunk[],
	remoteHunks: ChangeHunk[],
	options: {
		combineInsertions?: boolean;
		mergeOverlap?: (local: ChangeHunk, remote: ChangeHunk) => string[] | null;
	} = {},
): string[] | null {
	const merged: string[] = [];
	let baseIndex = 0;
	let localIndex = 0;
	let remoteIndex = 0;

	while (localIndex < localHunks.length || remoteIndex < remoteHunks.length) {
		const localHunk = localHunks[localIndex];
		const remoteHunk = remoteHunks[remoteIndex];

		if (!localHunk) {
			if (!remoteHunk) break;
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
			if (options.combineInsertions === false) return null;
			merged.push(...baseLines.slice(baseIndex, localHunk.start));
			const [first, second] = compareReplacements(localHunk.replacement, remoteHunk.replacement) <= 0
				? [localHunk.replacement, remoteHunk.replacement]
				: [remoteHunk.replacement, localHunk.replacement];
			merged.push(...first, ...second);
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

		if (sameRange(localHunk, remoteHunk)) {
			const replacement = options.mergeOverlap?.(localHunk, remoteHunk);
			if (replacement) {
				appendBaseAndHunk(merged, baseLines, baseIndex, { ...localHunk, replacement });
				baseIndex = localHunk.end;
				localIndex++;
				remoteIndex++;
				continue;
			}
		}
		return null;
	}

	merged.push(...baseLines.slice(baseIndex));
	return merged;
}

function compareReplacements(left: string[], right: string[]): number {
	const leftText = JSON.stringify(left);
	const rightText = JSON.stringify(right);
	if (leftText === rightText) return 0;
	return leftText < rightText ? -1 : 1;
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
