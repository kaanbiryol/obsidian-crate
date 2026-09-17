import { $addUpdateTag, HISTORY_MERGE_TAG, $getRoot, $getSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH, SELECTION_CHANGE_COMMAND, BLUR_COMMAND, COMPOSITION_END_COMMAND, PASTE_COMMAND, RootNode, type LexicalEditor } from 'lexical';
import { mergeRegister } from '@lexical/utils';
import { commitReminderMarkers } from '../../utils/reminderEditorEdits';
import { findLinkMatches } from '../../utils/richTextMatchers';
import { $decorateReminder, $readReminder, $writeReminder } from './reminderDocument';
import { $restoreOffsets, $selectionOffsets } from './selection';

export function registerReminderEditing(editor: LexicalEditor, projects: () => string[], markers: () => boolean = () => true) {
  let committed = editor.getEditorState().read($readReminder);
  let pasting = false;
  let revealedLink: number | undefined;
  const refreshLinks = (text: string, nextOffsets: ReturnType<typeof $selectionOffsets>) => {
    const root = editor.getRootElement();
    const focused = editor.isEditable() && root && (root.getRootNode() as Document | ShadowRoot).activeElement === root;
    const allLinks = findLinkMatches(text);
    let caret = focused && nextOffsets && nextOffsets.anchor === nextOffsets.focus ? nextOffsets.focus : undefined;
    // Keep an exposed destination editable while selecting part of its syntax.
    if (focused && nextOffsets && caret === undefined && revealedLink !== undefined) {
      const active = allLinks.find(link => link.index === revealedLink);
      if (active && Math.min(nextOffsets.anchor, nextOffsets.focus) < active.index + active.length
        && Math.max(nextOffsets.anchor, nextOffsets.focus) > active.index) caret = active.index;
    }
    revealedLink = allLinks.find(link => caret !== undefined && caret >= link.index && caret <= link.index + link.length)?.index;
    const links = allLinks.filter(link => caret === undefined || caret < link.index || caret > link.index + link.length);
    let visible = text;
    for (const link of [...links].reverse()) visible = visible.slice(0, link.index) + link.linkText + visible.slice(link.index + link.length);
    const currentVisible = $getRoot().getChildren().map(node => node.getTextContent()).join('\n');
    const renderedLinks = $getRoot().getAllTextNodes().filter(node => node.getParent()?.getType() === 'reminder-link').length;
    if (text !== $readReminder() || visible !== currentVisible || renderedLinks !== links.length) {
      if (text === editor.getEditorState().read($readReminder)) $addUpdateTag(HISTORY_MERGE_TAG);
      $writeReminder(text, projects(), caret, markers());
      const toVisible = (offset: number) => {
        let result = offset;
        for (const link of links) {
          if (offset >= link.index + link.length) result -= link.length - (link.linkText?.length ?? 0);
          else if (offset > link.index && link.length !== link.linkText?.length) result -= Math.min(offset - link.index, 1);
        }
        return result;
      };
      $restoreOffsets(focused && nextOffsets ? { anchor: toVisible(nextOffsets.anchor), focus: toVisible(nextOffsets.focus) } : null);
    }
  };
  return mergeRegister(
    editor.registerCommand(SELECTION_CHANGE_COMMAND, () => {
      if (!editor.isComposing()) refreshLinks($readReminder(), $selectionOffsets(true));
      return false;
    }, COMMAND_PRIORITY_HIGH),
    editor.registerCommand(BLUR_COMMAND, () => {
      if (!editor.isComposing()) refreshLinks($readReminder(), null);
      return false;
    }, COMMAND_PRIORITY_HIGH),
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
      if (markers() && offsets && $isRangeSelection(selection) && selection.isCollapsed()) {
        const next = commitReminderMarkers(text, offsets.focus, projects(), pasting, committed);
        if (pasting || /\s/.test(text[offsets.focus - 1] ?? '')) committed = next.text;
        if (next.text !== text) {
          text = next.text;
          nextOffsets = { anchor: next.cursor, focus: next.cursor };
        }
      }
      pasting = false;
      refreshLinks(text, nextOffsets);
      if (markers()) $decorateReminder(projects());
    }),
    editor.registerUpdateListener(({ editorState, tags }) => {
      if (tags.has('external-value') || tags.has('historic')) committed = editorState.read($readReminder);
    }),
  );
}
