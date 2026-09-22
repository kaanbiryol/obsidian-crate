import { $addUpdateTag, HISTORY_MERGE_TAG, $getRoot, $getSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH, SELECTION_CHANGE_COMMAND, BLUR_COMMAND, COMPOSITION_END_COMMAND, PASTE_COMMAND, RootNode, type LexicalEditor } from 'lexical';
import { mergeRegister } from '@lexical/utils';
import { findLinkMatches } from '../../utils/richTextMatchers';
import { isSafeUrl } from '../../utils/markdownLinks';
import { $decorateReminder, $readReminder, $writeReminder } from './reminderDocument';
import { $restoreOffsets, $selectionOffsets } from './selection';
import { normalizePageTitle, type PageTitleResolver } from './pageTitles';

export function registerReminderEditing(editor: LexicalEditor, projects: () => string[], markers: () => boolean = () => true, titleResolver: () => PageTitleResolver | undefined = () => undefined) {
  let revealedLink: number | undefined;
  let pendingTitle: { url: string; markdown: string; start: number; resolve: PageTitleResolver } | undefined;
  let revision = 0;
  let lastText = editor.getEditorState().read($readReminder);
  let disposed = false;
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
    () => { disposed = true; revision++; },
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
      if (!editor.isEditable() || !event || !('clipboardData' in event) || !event.clipboardData) return false;
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      event.preventDefault();
      let text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
      const url = text.trim();
      const offsets = $selectionOffsets(true);
      const start = offsets ? Math.min(offsets.anchor, offsets.focus) : 0;
      const end = offsets ? Math.max(offsets.anchor, offsets.focus) : 0;
      // Leave partial link edits alone so pasting a destination never nests links.
      const insideLink = offsets && findLinkMatches($readReminder()).some(link =>
        start === end ? start > link.index && start < link.index + link.length
          : start < link.index + link.length && end > link.index);
      const label = selection.isCollapsed() ? url : selection.getTextContent();
      if (!insideLink && /^https?:\/\/[^\s<>]+$/i.test(url) && isSafeUrl(url)
        && label && !/[[\]\\\n]/.test(label)) {
        // The shared Markdown parser uses closing parentheses as delimiters.
        const destination = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
        text = `[${label}](${destination})`;
        const resolve = titleResolver();
        if (selection.isCollapsed() && resolve) pendingTitle = { url, markdown: text, start, resolve };
      }
      selection.insertRawText(text);
      return true;
    }, COMMAND_PRIORITY_HIGH),
    editor.registerNodeTransform(RootNode, () => {
      if (editor.isComposing()) return;
      // Recognition only decorates text; typing and paste never remove markers.
      refreshLinks($readReminder(), $selectionOffsets(true));
      if (markers()) $decorateReminder(projects());
    }),
    editor.registerUpdateListener(({ editorState, tags }) => {
      const text = editorState.read($readReminder);
      if (text !== lastText || tags.has('external-value') || tags.has('historic')) revision++;
      lastText = text;
      const pending = pendingTitle;
      pendingTitle = undefined;
      if (!pending || text.slice(pending.start, pending.start + pending.markdown.length) !== pending.markdown) return;
      const requestedRevision = revision;
      void Promise.resolve().then(() => disposed || revision !== requestedRevision || titleResolver() !== pending.resolve
        ? null : pending.resolve(pending.url)).then(rawTitle => {
        const root = editor.getRootElement();
        if (!root || disposed || !editor.isEditable() || editor.isComposing() || revision !== requestedRevision || titleResolver() !== pending.resolve || !rawTitle) return;
        const title = normalizePageTitle(rawTitle, root.ownerDocument);
        if (!title) return;
        editor.update(() => {
          if ($readReminder() !== text) return;
          const replacement = pending.markdown.replace(/^\[[\s\S]*?\]\(/, () => `[${title}](`);
          const offsets = $selectionOffsets(true);
          const end = pending.start + pending.markdown.length;
          const shift = (offset: number) => offset >= end ? offset + replacement.length - pending.markdown.length
            : offset > pending.start ? pending.start + Math.min(offset - pending.start, title.length + 1) : offset;
          refreshLinks(text.slice(0, pending.start) + replacement + text.slice(end), offsets ? { anchor: shift(offsets.anchor), focus: shift(offsets.focus) } : null);
        }, { tag: HISTORY_MERGE_TAG });
      }).catch(() => undefined);
    }),
  );
}
