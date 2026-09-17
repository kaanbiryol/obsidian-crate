import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { $getRoot, $getSelection, $isRangeSelection, createEditor } from 'lexical';
import { ReminderTextNode } from './ReminderTextNode';
import { ReminderLinkNode } from './ReminderLinkNode';
import { $decorateReminder, $readReminder, $writeReminder } from './reminderDocument';
import { $restoreOffsets, $selectionOffsets } from './selection';

const projects = ['Work', 'Crate Demo', '日本語'];
function makeEditor(value: string) {
  const editor = createEditor({ nodes: [ReminderTextNode, ReminderLinkNode], onError: error => { throw error; } });
  editor.update(() => $writeReminder(value, projects), { discrete: true });
  return editor;
}

const examples = [
  '', 'plain text', '  leading and trailing  ', '\n', 'a\n\nb\n',
  '👩🏽‍💻 café e\u0301 日本語 العربية', '#Work ! tomorrow', '#Crate Demo',
  '[docs](https://example.com)', '[one](https://a.test) [two](https://b.test/path?q=1#x)',
  'before\n[docs](https://example.com)\nafter #Work', '[unfinished](https://',
  '<script>alert(1)</script> & "quoted"', '#Unknown ! !!!',
];

describe('Lexical Markdown boundary', () => {
  it.each(examples)('round-trips %j without losing text', value => {
    const editor = makeEditor(value);
    expect(editor.getEditorState().read($readReminder)).toBe(value);
    editor.update(() => { $decorateReminder(projects); $decorateReminder(projects); }, { discrete: true });
    expect(editor.getEditorState().read($readReminder)).toBe(value);
    const restored = editor.parseEditorState(JSON.stringify(editor.getEditorState().toJSON()));
    expect(restored.read($readReminder)).toBe(value);
  });

  it('preserves arbitrary mixed documents through repeated decoration and JSON history snapshots', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom('hello', ' ', '\n', '👩🏽‍💻', '日本語', '#Work', '!', '[docs](https://example.com)'), { maxLength: 35 }), pieces => {
      const value = pieces.join(' ');
      const editor = makeEditor(value);
      editor.update(() => { $decorateReminder(projects); $decorateReminder(projects); }, { discrete: true });
      expect(editor.getEditorState().read($readReminder)).toBe(value);
      expect(editor.parseEditorState(JSON.stringify(editor.getEditorState().toJSON())).read($readReminder)).toBe(value);
    }), { numRuns: 150, seed: 20260917 });
  });

  it('refreshes project decoration without changing Markdown', () => {
    const editor = makeEditor('Plan #New Project');
    const kinds = () => $getRoot().getAllTextNodes().filter(node => node instanceof ReminderTextNode && node.getKind() === 'project').map(node => node.getTextContent());
    expect(editor.getEditorState().read(kinds)).toEqual(['#New']);
    editor.update(() => $decorateReminder(['New Project']), { discrete: true });
    expect(editor.getEditorState().read(kinds)).toEqual(['#New Project']);
    editor.update(() => $decorateReminder([]), { discrete: true });
    expect(editor.getEditorState().read(kinds)).toEqual(['#New']);
    expect(editor.getEditorState().read($readReminder)).toBe('Plan #New Project');
  });
});

describe('Lexical selection mapping', () => {
  const value = 'A [docs](https://example.com)\n#Work 👩🏽‍💻 end';
  const visible = 'A docs\n#Work 👩🏽‍💻 end';
  it('restores every visible caret offset, including links, newlines and Unicode', () => {
    const editor = makeEditor(value);
    for (let offset = 0; offset <= visible.length; offset++) {
      editor.update(() => $restoreOffsets({ anchor: offset, focus: offset }), { discrete: true });
      expect(editor.getEditorState().read(() => $selectionOffsets())).toEqual({ anchor: offset, focus: offset });
    }
  });
  it.each([[0, 12], [12, 0], [3, 16], [16, 3]])('preserves range direction %i → %i through decoration', (anchor, focus) => {
    const editor = makeEditor(value);
    editor.update(() => { $restoreOffsets({ anchor, focus }); $decorateReminder(projects); }, { discrete: true });
    expect(editor.getEditorState().read(() => $selectionOffsets())).toEqual({ anchor, focus });
    expect(editor.getEditorState().read(() => { const selection = $getSelection(); return $isRangeSelection(selection) && selection.isBackward(); })).toBe(anchor > focus);
  });
  it('counts hidden Markdown syntax before the autocomplete caret', () => {
    const editor = makeEditor(value);
    editor.update(() => $restoreOffsets({ anchor: 12, focus: 12 }), { discrete: true });
    expect(editor.getEditorState().read(() => $selectionOffsets(true))).toEqual({ anchor: value.indexOf('#Work') + 5, focus: value.indexOf('#Work') + 5 });
  });
  it('clamps stale offsets and can clear the selection', () => {
    const editor = makeEditor('hello');
    editor.update(() => $restoreOffsets({ anchor: -5, focus: 1000 }), { discrete: true });
    expect(editor.getEditorState().read(() => $selectionOffsets())).toEqual({ anchor: 0, focus: 5 });
    editor.update(() => $restoreOffsets(null), { discrete: true });
    expect(editor.getEditorState().read(() => $selectionOffsets())).toBeNull();
  });
});
