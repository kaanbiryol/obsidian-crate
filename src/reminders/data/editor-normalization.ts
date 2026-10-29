import { MarkdownView, type EditorChange, type Workspace } from 'obsidian';

/** The note's text after an editor write; `complete` is false while lines still need one. */
interface EditorNormalization {
	content: string;
	complete: boolean;
}

/** Writes reminder normalization through the editor of an open note. */
export interface ReminderEditorWriter {
	/** Whether a loaded editor shows the file, so the vault must not rewrite it. */
	isOpen(filePath: string): boolean;
	/** Applies `normalized` to the editor showing `content`; null when no loaded editor shows the file. */
	write(filePath: string, content: string, normalized: string): EditorNormalization | null;
}

/**
 * Rewriting a file under its editor can drop unsaved typing, so open notes change
 * through one editor's transaction instead; Obsidian copies it to the note's other
 * tabs and saves the file. Deferred background tabs and reading views have no
 * editor text to lose and stay with the vault. `onHeld` runs when the line under a
 * focused cursor was left for a later scan.
 */
export function createReminderEditorWriter(workspace: Pick<Workspace, 'getLeavesOfType'>, onHeld: () => void): ReminderEditorWriter {
	const views = (filePath: string) => workspace.getLeavesOfType('markdown').map(leaf => leaf.view)
		.filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === filePath && view.getMode() === 'source');
	return {
		isOpen: filePath => views(filePath).length > 0,
		write(filePath, content, normalized) {
			const open = views(filePath);
			if (!open.length) return null;
			const editor = open[0]!.editor;
			// Unsaved typing is newer than the scanned file; its save starts another scan.
			if (editor.getValue() !== content) return { content, complete: false };
			const typing = new Set(open.filter(view => view.editor.hasFocus())
				.flatMap(view => view.editor.listSelections().map(selection => selection.head.line)));
			const before = content.split('\n'), lines = normalized.split('\n'), changes: EditorChange[] = [];
			let complete = true;
			for (const [line, text] of lines.entries()) {
				const previous = before[line]!;
				if (text === previous) continue;
				if (typing.has(line)) {
					lines[line] = previous;
					complete = false;
					continue;
				}
				// Change only the differing span so cursors elsewhere on the line keep their place.
				let start = 0, end = 0;
				while (start < previous.length && start < text.length && previous[start] === text[start]) start++;
				while (end < previous.length - start && end < text.length - start && previous[previous.length - 1 - end] === text[text.length - 1 - end]) end++;
				changes.push({ from: { line, ch: start }, to: { line, ch: previous.length - end }, text: text.slice(start, text.length - end) });
			}
			if (changes.length) editor.transaction({ changes });
			if (!complete) onHeld();
			return { content: lines.join('\n'), complete };
		},
	};
}
