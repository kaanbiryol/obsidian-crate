import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownView, TFile, type EditorPosition, type EditorTransaction, type Workspace } from 'obsidian';
import { createReminderByteVault } from '@/test/factories/reminder-byte-vault';
import { createReminderEditorWriter } from './editor-normalization';
import { createReminderIndex } from './reminder-index';

const inbox = 'Reminders/Inbox.md';

/** An editor buffer with Obsidian's transaction semantics: every change uses the original positions. */
function fakeEditor(text: string) {
	const state = { text, focused: false, cursorLine: 0 };
	const offset = ({ line, ch }: EditorPosition) => state.text.split('\n').slice(0, line).reduce((sum, value) => sum + value.length + 1, 0) + ch;
	const editor = {
		getValue: () => state.text,
		hasFocus: () => state.focused,
		listSelections: () => [{ anchor: { line: state.cursorLine, ch: 0 }, head: { line: state.cursorLine, ch: 0 } }],
		transaction: vi.fn(({ changes = [] }: EditorTransaction) => {
			const ranges = changes.map(change => ({ from: offset(change.from), to: offset(change.to ?? change.from), text: change.text }));
			for (const range of ranges.sort((left, right) => right.from - left.from)) state.text = state.text.slice(0, range.from) + range.text + state.text.slice(range.to);
		}),
	};
	return { state, editor };
}

function leaf(path: string, editor: ReturnType<typeof fakeEditor>['editor'], mode = 'source') {
	return { view: Object.assign(Object.create(MarkdownView.prototype) as object, { file: { path }, getMode: () => mode, editor }) };
}

function workspaceWith(leaves: object[]) {
	return { getLeavesOfType: (type: string) => type === 'markdown' ? leaves : [] } as unknown as Pick<Workspace, 'getLeavesOfType'>;
}

describe('reminder editor writer', () => {
	it('writes only the changed spans through one loaded editor as a single transaction', () => {
		const content = 'Notes\n- [ ] Task\n- [ ] Kept <!-- crate-id:kept -->';
		const normalized = 'Notes\n- [ ] Task <!-- crate-id:new -->\n- [ ] Kept <!-- crate-id:kept -->';
		const first = fakeEditor(content), second = fakeEditor(content);
		const writer = createReminderEditorWriter(workspaceWith([leaf(inbox, first.editor), leaf(inbox, second.editor)]), vi.fn());
		expect(writer.isOpen(inbox)).toBe(true);
		expect(writer.write(inbox, content, normalized)).toEqual({ content: normalized, complete: true });
		expect(first.editor.transaction).toHaveBeenCalledExactlyOnceWith({
			changes: [{ from: { line: 1, ch: 10 }, to: { line: 1, ch: 10 }, text: ' <!-- crate-id:new -->' }],
		});
		expect(first.state.text).toBe(normalized);
		// Obsidian copies the edit to the note's other tabs.
		expect(second.editor.transaction).not.toHaveBeenCalled();
	});

	it('leaves notes without a loaded source editor to the vault', () => {
		const { editor } = fakeEditor('- [ ] Task');
		for (const leaves of [[], [{ view: {} }], [leaf('Reminders/Other.md', editor)], [leaf(inbox, editor, 'preview')]]) {
			const writer = createReminderEditorWriter(workspaceWith(leaves), vi.fn());
			expect(writer.isOpen(inbox)).toBe(false);
			expect(writer.write(inbox, '- [ ] Task', '- [ ] Task <!-- crate-id:new -->')).toBeNull();
		}
		expect(editor.transaction).not.toHaveBeenCalled();
	});

	it('skips an editor whose unsaved text differs from the scanned note', () => {
		const { editor } = fakeEditor('- [ ] Task\n- [ ] Typing');
		const onHeld = vi.fn();
		const writer = createReminderEditorWriter(workspaceWith([leaf(inbox, editor)]), onHeld);
		expect(writer.write(inbox, '- [ ] Task', '- [ ] Task <!-- crate-id:new -->')).toEqual({ content: '- [ ] Task', complete: false });
		expect(editor.transaction).not.toHaveBeenCalled();
		expect(onHeld).not.toHaveBeenCalled();
	});

	it('holds the line under a focused cursor and writes the others', () => {
		const content = '- [ ] Done\n- [ ] Typing';
		const normalized = '- [ ] Done <!-- crate-id:a -->\n- [ ] Typing <!-- crate-id:b -->';
		const focused = fakeEditor(content);
		Object.assign(focused.state, { focused: true, cursorLine: 1 });
		const onHeld = vi.fn();
		expect(createReminderEditorWriter(workspaceWith([leaf(inbox, focused.editor)]), onHeld).write(inbox, content, normalized))
			.toEqual({ content: '- [ ] Done <!-- crate-id:a -->\n- [ ] Typing', complete: false });
		expect(focused.state.text).toBe('- [ ] Done <!-- crate-id:a -->\n- [ ] Typing');
		expect(onHeld).toHaveBeenCalledOnce();
		// Without focus nobody is typing, so the cursor's line is written too.
		const unfocused = fakeEditor(content);
		unfocused.state.cursorLine = 1;
		expect(createReminderEditorWriter(workspaceWith([leaf(inbox, unfocused.editor)]), vi.fn()).write(inbox, content, normalized))
			.toEqual({ content: normalized, complete: true });
	});
});

describe('reminder index with an open note', () => {
	const fixtures: Array<{ dispose(): Promise<void> }> = [];
	afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });

	async function setup(text: string, { open = true, editorText = text } = {}) {
		const h = await createReminderByteVault({ [inbox]: text });
		fixtures.push(h);
		const view = fakeEditor(editorText);
		const leaves: object[] = open ? [leaf(inbox, view.editor)] : [];
		const onHeld = vi.fn();
		const index = createReminderIndex(h.app, 'Reminders', { editor: createReminderEditorWriter(workspaceWith(leaves), onHeld) });
		const file = () => {
			const current = h.app.vault.getAbstractFileByPath(inbox);
			if (!(current instanceof TFile)) throw new Error('Test file is missing');
			return current;
		};
		const disk = async () => (await h.readBytes(inbox)).toString('utf8');
		// Obsidian saves the editor's text, and the watcher rescans the note.
		const save = async () => { await h.put(inbox, view.state.text); await index.rescanFile(file()); };
		const contents = () => index.getAll().map(reminder => reminder.content).sort();
		return { ...h, index, view, leaves, onHeld, disk, save, contents };
	}

	it('indexes reminders typed into an open note at once, writing through its editor', async () => {
		const typed = '- [ ] Existing <!-- crate-id:existing -->\n- [ ] Call the bank tomorrow\n';
		const h = await setup(typed);
		await h.index.load();
		expect(h.vault.process).not.toHaveBeenCalled();
		expect(await h.disk()).toBe(typed);
		expect(h.view.editor.transaction).toHaveBeenCalledOnce();
		expect(h.view.state.text).toMatch(/^- \[ \] Existing <!-- crate-id:existing -->\n- \[ \] Call the bank \d{4}-\d{2}-\d{2} <!-- crate-id:[^ ]+ -->\n$/);
		expect(h.contents()).toEqual(['Call the bank', 'Existing']);
		const id = h.index.getAll().find(reminder => reminder.content === 'Call the bank')!.id;

		await h.save();
		expect(h.view.editor.transaction).toHaveBeenCalledOnce();
		expect(h.vault.process).not.toHaveBeenCalled();
		expect(h.index.getById(id)?.content).toBe('Call the bank');
	});

	it('retries an editor with unsaved typing once Obsidian saves it', async () => {
		const saved = '- [ ] Existing <!-- crate-id:existing -->\n- [ ] Typed\n';
		const h = await setup(saved, { editorText: `${saved}- [ ] Still typing\n` });
		await h.index.load();
		expect(h.view.editor.transaction).not.toHaveBeenCalled();
		expect(h.vault.process).not.toHaveBeenCalled();
		expect(h.contents()).toEqual(['Existing']);
		await h.save();
		expect(h.view.editor.transaction).toHaveBeenCalledOnce();
		expect(h.contents()).toEqual(['Existing', 'Still typing', 'Typed']);
	});

	it('writes the line being typed once the cursor leaves it', async () => {
		const typed = '- [ ] Existing <!-- crate-id:existing -->\n- [ ] Typing\n';
		const h = await setup(typed);
		Object.assign(h.view.state, { focused: true, cursorLine: 1 });
		await h.index.load();
		expect(h.view.editor.transaction).not.toHaveBeenCalled();
		expect(h.onHeld).toHaveBeenCalledOnce();
		expect(h.contents()).toEqual(['Existing']);
		// The runtime flushes again shortly after a held line.
		h.view.state.cursorLine = 0;
		await h.index.flushDeferredScans();
		expect(h.view.state.text).toMatch(/^- \[ \] Existing <!-- crate-id:existing -->\n- \[ \] Typing <!-- crate-id:[^ ]+ -->\n$/);
		expect(h.contents()).toEqual(['Existing', 'Typing']);
		expect(h.vault.process).not.toHaveBeenCalled();
	});

	it('writes through the vault when the note has no loaded editor', async () => {
		const h = await setup('- [ ] Closed\n', { open: false });
		h.leaves.push({ view: {} });
		await h.index.load();
		expect(await h.disk()).toMatch(/^- \[ \] Closed <!-- crate-id:[^ ]+ -->\n$/);
		expect(h.view.editor.transaction).not.toHaveBeenCalled();
	});

	it('does not rewrite through the vault a note opened during the write', async () => {
		const typed = '- [ ] Draft\n';
		const h = await setup(typed, { open: false });
		const write = h.vault.process.getMockImplementation()!;
		h.vault.process.mockImplementationOnce(async (file, update) => { h.leaves.push(leaf(inbox, h.view.editor)); return write(file, update); });
		await h.index.load();
		expect(await h.disk()).toBe(typed);
		// Opening the tab changes the layout, which flushes pending writes.
		await h.index.flushDeferredScans();
		expect(h.view.state.text).toMatch(/^- \[ \] Draft <!-- crate-id:[^ ]+ -->\n$/);
		expect(h.contents()).toEqual(['Draft']);
	});
});
