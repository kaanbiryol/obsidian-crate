import { diffArrays } from 'diff';

export interface ChangeHunk {
	start: number;
	end: number;
	replacement: string[];
}

// An edit-count limit bounds work without making sync decisions depend on device speed.
const MAX_EDIT_LENGTH = 2_000;

/** Adapt jsdiff's token changes to the base-relative ranges used by Crate's merge rules. */
export function diffSequence(base: string[], target: string[]): ChangeHunk[] | null {
	const changes = diffArrays(base, target, { maxEditLength: MAX_EDIT_LENGTH });
	if (!changes) return null;

	const hunks: ChangeHunk[] = [];
	let baseIndex = 0;
	let hunk: ChangeHunk | undefined;
	for (const change of changes) {
		if (!change.added && !change.removed) {
			if (hunk) hunks.push(hunk);
			hunk = undefined;
			baseIndex += change.value.length;
			continue;
		}
		hunk ??= { start: baseIndex, end: baseIndex, replacement: [] };
		if (change.removed) {
			baseIndex += change.value.length;
			hunk.end = baseIndex;
		} else {
			hunk.replacement.push(...change.value);
		}
	}
	if (hunk) hunks.push(hunk);
	return hunks;
}
