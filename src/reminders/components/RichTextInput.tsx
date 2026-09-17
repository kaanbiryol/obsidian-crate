import React, { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { createEditor, $getRoot, COMPOSITION_END_COMMAND, COMPOSITION_END_TAG, HISTORY_PUSH_TAG, IS_APPLE_WEBKIT, IS_IOS, IS_SAFARI, SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG } from 'lexical';
import { registerPlainText } from '@lexical/plain-text';
import { createEmptyHistoryState, registerHistory } from '@lexical/history';
import { mergeRegister } from '@lexical/utils';
import { ReminderTextNode } from './lexical/ReminderTextNode';
import { ReminderLinkNode } from './lexical/ReminderLinkNode';
import { $readReminder, $writeReminder } from './lexical/reminderDocument';
import { $restoreOffsets, $selectionOffsets } from './lexical/selection';
import { registerReminderEditing } from './lexical/registerReminderEditing';
import { getEditorSelectionRange } from '../utils/editorSelection';
import { getLogicalCursorOffset } from '../utils/cursorPosition';
import { extractHashtagQuery } from '../utils/projectSearch';
import type { RichTextInputHandle, RichTextInputProps } from './lexical/types';
export type { RichTextInputHandle, RichTextInputProps } from './lexical/types';

function captureSelection(element: HTMLDivElement) {
  const range = getEditorSelectionRange(element);
  if (!range) return null;
  const start = getLogicalCursorOffset(element, range.startContainer, range.startOffset);
  const end = getLogicalCursorOffset(element, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  const selection = element.ownerDocument.getSelection();
  const backward = selection?.focusNode === range.startContainer && selection.focusOffset === range.startOffset;
  return backward ? { anchor: end, focus: start } : { anchor: start, focus: end };
}

/** Lexical owns editing and history; the app continues to read and write Markdown strings. */
export const RichTextInput = forwardRef<RichTextInputHandle, RichTextInputProps>((props, ref) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const editorRef = useRef<ReturnType<typeof createEditor> | null>(null);
  const pendingRef = useRef<{ pos: number; scrollTop?: number } | null>(null);
  const focusRequestRef = useRef(props.focusRequestKey);
  const projectKeyRef = useRef((props.knownProjects ?? []).join('\u0000'));

  const focus = useCallback((options: { select?: boolean } = {}) => {
    const editor = editorRef.current;
    const element = rootRef.current;
    if (!editor || !element) return;
    element.focus({ preventScroll: true });
    editor.update(() => {
      if (options.select) $getRoot().select(0, $getRoot().getChildrenSize());
      else $getRoot().selectEnd();
    }, { discrete: true, tag: SKIP_SCROLL_INTO_VIEW_TAG });
  }, []);

  useImperativeHandle(ref, () => ({
    focus,
    blur: () => rootRef.current?.blur(),
    getElement: () => rootRef.current,
    selectAll: () => focus({ select: true }),
    setCursorPosition: (pos, options = {}) => { pendingRef.current = { pos, ...options }; },
  }), [focus]);

  const setRoot = useCallback((element: HTMLDivElement | null) => {
    rootRef.current = element;
    if (latest.current.inputRef) latest.current.inputRef.current = element;
  }, []);

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const editor = createEditor({
      namespace: 'crate-reminder',
      nodes: [ReminderTextNode, ReminderLinkNode],
      theme: { paragraph: 'lexical-reminder-paragraph', link: 'reminder-markdown-link' },
      editable: !latest.current.readOnly,
      onError: error => { throw error; },
    });
    editorRef.current = editor;
    editor.setRootElement(element);
    editor.update(() => $writeReminder(latest.current.value, latest.current.knownProjects ?? [], undefined, latest.current.markers !== false), {
      discrete: true, tag: ['external-value', SKIP_DOM_SELECTION_TAG],
    });
    const history = createEmptyHistoryState();
    history.current = { editor, editorState: editor.getEditorState() };
    const unregister = mergeRegister(
      registerPlainText(editor),
      registerHistory(editor, history, 300, Date.now, undefined, 100),
      registerReminderEditing(editor, () => latest.current.knownProjects ?? [], () => latest.current.markers !== false),
      editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => {
        if (editor.isComposing() || tags.has('external-value') || (!dirtyElements.size && !dirtyLeaves.size && !tags.has(COMPOSITION_END_TAG))) return;
        const { text, offsets } = editorState.read(() => ({ text: $readReminder(), offsets: $selectionOffsets(true) }));
        if (text !== latest.current.value) latest.current.onChange(text);
        const query = offsets ? extractHashtagQuery(text, offsets.focus) : null;
        latest.current.onAutocompleteQuery?.(query?.query ?? null, query ? getEditorSelectionRange(element)?.getBoundingClientRect() ?? null : null);
      }),
    );
    const selectEnd = (event: Event) => {
      event.preventDefault();
      editor.update(() => $getRoot().selectEnd(), { discrete: true, tag: SKIP_SCROLL_INTO_VIEW_TAG });
    };
    element.addEventListener('crate-editor-select-end', selectEnd);
    // Lexical 0.50 defers desktop Safari compositionend until another key.
    // Publish the committed draft even if the next action is Save, not typing.
    const finishComposition = (event: CompositionEvent) => {
      if (!IS_IOS && (IS_SAFARI || IS_APPLE_WEBKIT) && editor.isComposing()) {
        editor.dispatchCommand(COMPOSITION_END_COMMAND, event);
      }
    };
    element.addEventListener('compositionend', finishComposition);
    if (latest.current.autoFocus && !latest.current.readOnly) focus();
    return () => {
      element.removeEventListener('crate-editor-select-end', selectEnd);
      element.removeEventListener('compositionend', finishComposition);
      unregister();
      editor.setRootElement(null);
      editorRef.current = null;
    };
  }, [focus]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    const element = rootRef.current;
    if (!editor || !element) return;
    editor.setEditable(!props.readOnly);
    if (props.autoComplete) element.setAttribute('autocomplete', props.autoComplete);
    const changed = editor.getEditorState().read($readReminder) !== props.value;
    const projectKey = (props.knownProjects ?? []).join('\u0000');
    const projectsChanged = projectKey !== projectKeyRef.current;
    projectKeyRef.current = projectKey;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (changed || pending || projectsChanged) {
      const active = (element.getRootNode() as Document | ShadowRoot).activeElement === element;
      const offsets = pending ? { anchor: pending.pos, focus: pending.pos }
        : active && props.preserveSelection !== false ? captureSelection(element) : null;
      const scrollTop = pending?.scrollTop ?? element.scrollTop;
      editor.update(() => {
        if (changed) $writeReminder(props.value, props.knownProjects ?? [], undefined, props.markers !== false);
        else if (projectsChanged) $getRoot().markDirty();
        if (!pending && active && props.externalChangeCursor === 'end') $getRoot().selectEnd();
        else $restoreOffsets(offsets);
      }, { discrete: true, tag: ['external-value', ...(changed ? [HISTORY_PUSH_TAG] : []), SKIP_SCROLL_INTO_VIEW_TAG, ...(!active ? [SKIP_DOM_SELECTION_TAG] : [])] });
      element.scrollTop = scrollTop;
    }
    if (props.focusRequestKey !== focusRequestRef.current) {
      focusRequestRef.current = props.focusRequestKey;
      if (!props.readOnly) focus();
    }
  }, [props.value, props.knownProjects, props.readOnly, props.autoComplete, props.preserveSelection, props.externalChangeCursor, props.focusRequestKey, focus]);

  return <div className="rich-text-input-shell"><div ref={setRoot}
    contentEditable={!props.readOnly} role="textbox" aria-label={props.ariaLabel ?? props.placeholder}
    aria-multiline="true" aria-readonly={props.readOnly} aria-autocomplete={props.ariaControls ? 'list' : undefined}
    aria-controls={props.ariaControls} aria-activedescendant={props.ariaActiveDescendant} aria-expanded={props.ariaExpanded}
    inputMode="text" autoCorrect={props.autoCorrect} spellCheck={props.spellCheck}
    onKeyDownCapture={event => {
      if (event.nativeEvent.isComposing) return;
      if (props.onAutocompleteKeyDown?.(event)) { event.preventDefault(); event.stopPropagation(); return; }
      props.onKeyDown?.(event);
      if (event.defaultPrevented) event.stopPropagation();
    }}
    onMouseDown={event => {
      // Keep the rendered anchor available until the modifier-click opens it.
      if ((event.metaKey || event.ctrlKey) && (event.target as Element).closest('a[data-markdown-link]')) event.preventDefault();
    }}
    onClick={event => {
      const link = (event.target as Element).closest<HTMLAnchorElement>('a[data-markdown-link]');
      if (!link) return;
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) window.open(link.href, '_blank', 'noopener,noreferrer');
    }}
    onFocus={props.onFocus} onBlur={props.onBlur} onPointerDown={props.onPointerDown}
    className={`rich-text-input-editor${props.className ? ` ${props.className}` : ''}`}
    data-placeholder={!props.value ? props.placeholder : ''} data-editor="lexical"
    suppressContentEditableWarning style={props.style} /></div>;
});
