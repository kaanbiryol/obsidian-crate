export interface RichTextHistorySnapshot {
	value: string;
	cursor: number | null;
}

export type RichTextHistoryAction = 'undo' | 'redo';

const MAX_HISTORY_LENGTH = 100;

function snapshotsMatch(
	left: RichTextHistorySnapshot | undefined,
	right: RichTextHistorySnapshot,
): boolean {
	return left?.value === right.value && left.cursor === right.cursor;
}

function appendSnapshot(
	stack: RichTextHistorySnapshot[],
	snapshot: RichTextHistorySnapshot,
): void {
	if (snapshotsMatch(stack.at(-1), snapshot)) {
		return;
	}

	stack.push(snapshot);
	if (stack.length > MAX_HISTORY_LENGTH) {
		stack.shift();
	}
}

export class RichTextInputHistory {
	private current: RichTextHistorySnapshot;
	private pending: RichTextHistorySnapshot | null = null;
	private readonly undoStack: RichTextHistorySnapshot[] = [];
	private readonly redoStack: RichTextHistorySnapshot[] = [];

	constructor(initial: RichTextHistorySnapshot) {
		this.current = initial;
	}

	capture(snapshot: RichTextHistorySnapshot): void {
		this.pending = snapshot;
	}

	record(snapshot: RichTextHistorySnapshot): void {
		const previous = this.pending ?? this.current;
		this.pending = null;

		if (previous.value !== snapshot.value) {
			appendSnapshot(this.undoStack, previous);
			this.redoStack.length = 0;
		}

		this.current = snapshot;
	}

	reset(snapshot: RichTextHistorySnapshot): void {
		this.current = snapshot;
		this.pending = null;
		this.undoStack.length = 0;
		this.redoStack.length = 0;
	}

	undo(current: RichTextHistorySnapshot): RichTextHistorySnapshot | null {
		this.pending = null;
		const previous = this.undoStack.pop() ?? null;
		if (!previous) {
			return null;
		}

		appendSnapshot(this.redoStack, current);
		this.current = previous;
		return previous;
	}

	redo(current: RichTextHistorySnapshot): RichTextHistorySnapshot | null {
		this.pending = null;
		const next = this.redoStack.pop() ?? null;
		if (!next) {
			return null;
		}

		appendSnapshot(this.undoStack, current);
		this.current = next;
		return next;
	}
}

export function getRichTextHistoryAction(event: {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
}): RichTextHistoryAction | null {
	if (event.altKey || (!event.metaKey && !event.ctrlKey)) {
		return null;
	}

	const key = event.key.toLowerCase();
	if (key === 'z') {
		return event.shiftKey ? 'redo' : 'undo';
	}

	if (key === 'y' && event.ctrlKey && !event.shiftKey) {
		return 'redo';
	}

	return null;
}
