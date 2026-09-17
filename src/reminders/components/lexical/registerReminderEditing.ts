import { $getRoot, $getSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH, COMPOSITION_END_COMMAND, PASTE_COMMAND, RootNode, type LexicalEditor } from 'lexical';
import { $isLinkNode } from '@lexical/link';
import { mergeRegister } from '@lexical/utils';
import { commitReminderMarkers, toReminderCursorOffset } from '../../utils/reminderEditorEdits';
import { findLinkMatches } from '../../utils/richTextMatchers';
import { $decorateReminder, $readReminder, $writeReminder } from './reminderDocument';
import { $restoreOffsets, $selectionOffsets } from './selection';

export function registerReminderEditing(editor: LexicalEditor, projects: () => string[]) {
  let committed = editor.getEditorState().read($readReminder);
  let pasting = false;
  return mergeRegister(
    editor.registerCommand(COMPOSITION_END_COMMAND, () => {
      $getRoot().markDirty();
      return false;
    }, COMMAND_PRIORITY_HIGH),
    editor.registerCommand(PASTE_COMMAND, event => {
      if (!event || !('clipboardData' in event) || !event.clipboardData) return false;
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      event.preventDefault();
      pasting = true;
      selection.insertRawText(event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'));
      return true;
    }, COMMAND_PRIORITY_HIGH),
    editor.registerNodeTransform(RootNode, () => {
      if (editor.isComposing()) return;
      let text = $readReminder();
      const offsets = $selectionOffsets(true);
      const selection = $getSelection();
      let nextOffsets = offsets;
      if (offsets && $isRangeSelection(selection) && selection.isCollapsed()) {
        const next = commitReminderMarkers(text, offsets.focus, projects(), pasting, committed);
        if (pasting || /\s/.test(text[offsets.focus - 1] ?? '')) committed = next.text;
        if (next.text !== text) {
          text = next.text;
          nextOffsets = { anchor: next.cursor, focus: next.cursor };
        }
      }
      pasting = false;
      const hasNewLink = $getRoot().getAllTextNodes().some(node => !$isLinkNode(node.getParent()) && findLinkMatches(node.getTextContent()).length > 0);
      if (text !== $readReminder() || hasNewLink) {
        $writeReminder(text, projects());
        $restoreOffsets(nextOffsets && {
          anchor: toReminderCursorOffset(text, nextOffsets.anchor),
          focus: toReminderCursorOffset(text, nextOffsets.focus),
        });
      }
      $decorateReminder(projects());
    }),
    editor.registerUpdateListener(({ editorState, tags }) => {
      if (tags.has('external-value') || tags.has('historic')) committed = editorState.read($readReminder);
    }),
  );
}
