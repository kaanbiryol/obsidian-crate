import React, { useRef, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, useCallback } from 'react';
import { buildHTML, buildRichTextSegments, getPlainText, getRichTextChipParts } from '../utils/richTextParsing';
import { getLogicalTextLength, saveCursorPosition, restoreCursorPosition } from '../utils/cursorPosition';
import { extractHashtagQuery } from '../utils/projectSearch';
import {
    clearActiveRichTextChip,
    focusRichTextElement,
    isRichTextRenderingCurrent,
    renderRichText,
    selectElementContents,
    syncActiveRichTextChip,
} from './richTextInputDom';
import {
    RichTextInputHistory,
    type RichTextHistoryAction,
    type RichTextHistorySnapshot,
} from './richTextInputHistory';
import { useRichTextInputInteractions } from './useRichTextInputInteractions';

export interface RichTextInputHandle {
    /** Focus the input */
    focus: (options?: { select?: boolean }) => void;
    /** Blur the input (dismiss keyboard on mobile) */
    blur: () => void;
    /** Get the underlying DOM element */
    getElement: () => HTMLDivElement | null;
    /** Select all editable content */
    selectAll: () => void;
    /** Set a pending cursor position to be applied on next content update */
    setCursorPosition: (pos: number, options?: { scrollTop?: number }) => void;
}

interface RichTextInputProps {
    value: string;
    onChange: (value: string) => void;
    onKeyDown?: (e: React.KeyboardEvent) => void;
    onFocus?: (e: React.FocusEvent) => void;
    onBlur?: (e: React.FocusEvent) => void;
    onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
    placeholder?: string;
    ariaLabel?: string;
    ariaControls?: string;
    ariaActiveDescendant?: string;
    ariaExpanded?: boolean;
    inputRef?: React.RefObject<HTMLDivElement | null>;
    className?: string;
    style?: React.CSSProperties;
    autoFocus?: boolean;
    autoComplete?: string;
    autoCorrect?: 'on' | 'off';
    spellCheck?: boolean;
    /** Increment to synchronously refocus the mounted editor from a user interaction. */
    focusRequestKey?: number;
    readOnly?: boolean;
    /** Preserve cursor position when value is updated externally */
    preserveSelection?: boolean;
    /** Choose where to restore the cursor after an external value update. */
    externalChangeCursor?: 'preserve' | 'end';
    /** Known project names for multi-word project highlighting */
    knownProjects?: string[];
    /** Callback when a # autocomplete query changes. null = no active autocomplete. */
    onAutocompleteQuery?: (query: string | null, rect: DOMRect | null) => void;
    /** Handler for autocomplete keyboard navigation. Return true if handled. */
    onAutocompleteKeyDown?: (e: React.KeyboardEvent) => boolean;
    /** Synchronize external values before paint for the standalone PWA editor. */
    syncContentBeforePaint?: boolean;
}

function renderTextWithLineBreaks(text: string, keyPrefix: string): React.ReactNode[] {
    return text.split('\n').flatMap((line, index, lines) => [
        line,
        ...(index < lines.length - 1 ? [<br key={`${keyPrefix}-br-${index}`} />] : []),
    ]);
}

function renderInitialRichText(text: string, knownProjects?: string[]): React.ReactNode[] {
    return buildRichTextSegments(text, knownProjects).map((segment, index) => {
        const key = `${segment.kind}-${index}`;
        if (segment.kind === 'text') {
            return <React.Fragment key={key}>{renderTextWithLineBreaks(segment.text, key)}</React.Fragment>;
        }
        if (segment.kind === 'link') {
            return (
                <a
                    key={key}
                    href={segment.url}
                    className="reminder-markdown-link"
                    data-markdown-link="true"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {renderTextWithLineBreaks(segment.text, key)}
                </a>
            );
        }
        const { marker, label } = getRichTextChipParts(segment.type, segment.text);
        return (
            <span key={key} className={`rich-text-chip rich-text-chip-${segment.type}`}>
                {marker ? <span className="rich-text-chip-marker">{marker}</span> : null}
                {renderTextWithLineBreaks(label, key)}
            </span>
        );
    });
}

export const RichTextInput = forwardRef<RichTextInputHandle, RichTextInputProps>(({
    value,
    onChange,
    onKeyDown,
    onFocus,
    onBlur,
    onPointerDown,
    placeholder,
    ariaLabel,
    ariaControls,
    ariaActiveDescendant,
    ariaExpanded,
    inputRef,
    className,
    style,
    autoFocus = false,
    autoComplete,
    autoCorrect,
    spellCheck,
    focusRequestKey = 0,
    readOnly = false,
    preserveSelection = true,
    externalChangeCursor = 'preserve',
    knownProjects,
    onAutocompleteQuery,
    onAutocompleteKeyDown,
    syncContentBeforePaint = false,
}, ref) => {
    const editableRef = useRef<HTMLDivElement>(null);
    const hasInitializedRef = useRef(false);
    const knownProjectsKeyRef = useRef(knownProjects ? knownProjects.join('\u0000') : '');
    const pendingCursorRef = useRef<number | null>(null);
    const pendingScrollTopRef = useRef<number | null>(null);
    const restoreRequestIdRef = useRef(0);
    const initialContentRef = useRef<{ text: string; knownProjects?: string[] } | null>(null);
    const lastFocusRequestRef = useRef(focusRequestKey);
    const historyRef = useRef<RichTextInputHistory | null>(null);

    if (!historyRef.current) {
        historyRef.current = new RichTextInputHistory({
            value,
            cursor: value.length,
        });
    }

    if ((syncContentBeforePaint || autoFocus) && !initialContentRef.current) {
        initialContentRef.current = {
            text: value,
            knownProjects: knownProjects ? [...knownProjects] : undefined,
        };
    }

    // Use provided ref or internal one
    const actualRef = inputRef || editableRef;

    // Ref callback to update refs when element attaches to DOM
    const refCallback = useCallback((el: HTMLDivElement | null) => {
        if (inputRef) {
            inputRef.current = el;
        } else {
            editableRef.current = el;
        }

        if (el && autoComplete) {
            // React's div typings omit autocomplete even though WebKit accepts
            // the hint on editable content.
            el.setAttribute('autocomplete', autoComplete);
        }

        if (!el || !autoFocus || hasInitializedRef.current) return;
        hasInitializedRef.current = true;
        focusRichTextElement(el);
    }, [autoComplete, autoFocus, inputRef]);

    // Expose methods to parent via ref
    useImperativeHandle(ref, () => ({
        focus: (options = {}) => {
            if (actualRef.current) {
                focusRichTextElement(actualRef.current, options);
            }
        },
        blur: () => {
            if (actualRef.current) {
                actualRef.current.blur();
            }
        },
        getElement: () => actualRef.current,
        selectAll: () => {
            if (actualRef.current) {
                actualRef.current.focus({ preventScroll: true });
                selectElementContents(actualRef.current);
            }
        },
        setCursorPosition: (pos: number, options = {}) => {
            pendingCursorRef.current = pos;
            pendingScrollTopRef.current = options.scrollTop ?? null;
        },
    }));

    useEffect(() => {
        const element = actualRef.current;
        if (!element) return;

        const ownerDocument = element.ownerDocument;
        const syncCursorChip = () => syncActiveRichTextChip(element);
        const clearCursorChip = () => clearActiveRichTextChip(element);

        ownerDocument.addEventListener('selectionchange', syncCursorChip);
        element.addEventListener('focus', syncCursorChip);
        element.addEventListener('blur', clearCursorChip);
        syncCursorChip();

        return () => {
            ownerDocument.removeEventListener('selectionchange', syncCursorChip);
            element.removeEventListener('focus', syncCursorChip);
            element.removeEventListener('blur', clearCursorChip);
        };
    }, [actualRef]);

    const scheduleSelectionRestore = useCallback((position: number | null, afterRestore?: () => void) => {
        const requestId = ++restoreRequestIdRef.current;
        window.requestAnimationFrame(() => {
            if (restoreRequestIdRef.current !== requestId || !actualRef.current) {
                return;
            }

            restoreCursorPosition(actualRef.current, position);
            syncActiveRichTextChip(actualRef.current);
            afterRestore?.();
        });
    }, [actualRef]);

    const getCurrentHistorySnapshot = useCallback((): RichTextHistorySnapshot | null => {
        if (!actualRef.current) return null;
        return {
            value: getPlainText(actualRef.current),
            cursor: saveCursorPosition(actualRef.current),
        };
    }, [actualRef]);

    const updateAutocompleteQuery = useCallback((plainText: string, cursorPos: number | null) => {
        if (!onAutocompleteQuery || cursorPos === null) {
            return;
        }

        const hashInfo = extractHashtagQuery(plainText, cursorPos);
        if (hashInfo) {
            const sel = window.getSelection();
            const rect = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
            onAutocompleteQuery(hashInfo.query, rect ?? null);
            return;
        }

        onAutocompleteQuery(null, null);
    }, [onAutocompleteQuery]);

    const captureHistorySnapshot = useCallback(() => {
        const snapshot = getCurrentHistorySnapshot();
        if (snapshot) {
            historyRef.current?.capture(snapshot);
        }
    }, [getCurrentHistorySnapshot]);

    const applyHistoryAction = useCallback((action: RichTextHistoryAction): boolean => {
        if (!actualRef.current) return false;

        const current = getCurrentHistorySnapshot();
        if (!current) return false;

        const snapshot = action === 'undo'
            ? historyRef.current?.undo(current)
            : historyRef.current?.redo(current);
        if (!snapshot) return false;

        restoreRequestIdRef.current += 1;
        renderRichText(actualRef.current, snapshot.value, knownProjects);
        restoreCursorPosition(actualRef.current, snapshot.cursor);
        syncActiveRichTextChip(actualRef.current);
        onChange(snapshot.value);
        updateAutocompleteQuery(snapshot.value, snapshot.cursor);
        return true;
    }, [actualRef, getCurrentHistorySnapshot, knownProjects, onChange, updateAutocompleteQuery]);

    // Handle input changes
    const handleInput = () => {
        if (readOnly || !actualRef.current) return;

        // A native edit supersedes any caret restoration queued for an older DOM state.
        restoreRequestIdRef.current += 1;

        const cursorPos = saveCursorPosition(actualRef.current);
        const plainText = getPlainText(actualRef.current);
        historyRef.current?.record({ value: plainText, cursor: cursorPos });

        // Build and render HTML with chips
        const html = buildHTML(plainText, knownProjects);
        const normalizedHtml = html || '';
        const shouldRerender = !isRichTextRenderingCurrent(actualRef.current, normalizedHtml);
        if (shouldRerender) {
            renderRichText(actualRef.current, plainText, knownProjects);
            // Keep selection valid before another keyboard event can arrive. Waiting for
            // animationFrame here leaves fast typing vulnerable to a reset caret.
            restoreCursorPosition(actualRef.current, cursorPos);
            syncActiveRichTextChip(actualRef.current);
        }

        // Call onChange with plain text
        onChange(plainText);

        updateAutocompleteQuery(plainText, cursorPos);
    };

    const syncExternalContent = useCallback(() => {
        if (!actualRef.current) return;

        const currentPlainText = getPlainText(actualRef.current);
        const knownProjectsKey = knownProjects ? knownProjects.join('\u0000') : '';
        const knownProjectsChanged = knownProjectsKey !== knownProjectsKeyRef.current;
        knownProjectsKeyRef.current = knownProjectsKey;

        if (currentPlainText === value && !knownProjectsChanged) {
            return;
        }

        const html = buildHTML(value, knownProjects);
        const normalizedHtml = html || '';

        if (isRichTextRenderingCurrent(actualRef.current, normalizedHtml)) {
            return;
        }

        const root = actualRef.current.getRootNode() as Document | ShadowRoot;
        const activeElement = root.activeElement;
        const isFocused = activeElement === actualRef.current;
        const shouldPreserveCursor = preserveSelection && isFocused;
        const cursorPos = shouldPreserveCursor ? saveCursorPosition(actualRef.current) : null;

        renderRichText(actualRef.current, value, knownProjects);

        if (currentPlainText !== value) {
            historyRef.current?.reset({ value, cursor: value.length });
        }

        if (pendingCursorRef.current !== null) {
            const pendingPos = pendingCursorRef.current;
            const pendingScrollTop = pendingScrollTopRef.current;
            pendingCursorRef.current = null;
            pendingScrollTopRef.current = null;
            scheduleSelectionRestore(pendingPos, () => {
                if (pendingScrollTop !== null && actualRef.current) {
                    actualRef.current.scrollTop = pendingScrollTop;
                }
            });
        } else if (shouldPreserveCursor) {
            scheduleSelectionRestore(
                externalChangeCursor === 'end'
                    ? getLogicalTextLength(actualRef.current)
                    : cursorPos,
            );
        }
    }, [actualRef, externalChangeCursor, knownProjects, preserveSelection, scheduleSelectionRestore, value]);

    // Keep the plugin's existing passive update behavior. The standalone PWA opts
    // into a pre-paint sync to avoid showing the previous reminder for one frame.
    useEffect(() => {
        if (!syncContentBeforePaint) {
            syncExternalContent();
        }
    }, [syncContentBeforePaint, syncExternalContent]);

    useLayoutEffect(() => {
        if (syncContentBeforePaint) {
            syncExternalContent();
        }
    }, [syncContentBeforePaint, syncExternalContent]);

    useLayoutEffect(() => {
        if (focusRequestKey === lastFocusRequestRef.current) return;
        lastFocusRequestRef.current = focusRequestKey;
        if (actualRef.current) {
            focusRichTextElement(actualRef.current);
        }
    }, [actualRef, focusRequestKey]);

    const {
        handleClick,
        handleKeyDownInternal,
        handlePaste,
        handleMouseDown,
        handleTouchStart,
    } = useRichTextInputInteractions({
        onKeyDown,
        onAutocompleteKeyDown,
        onUndo: () => applyHistoryAction('undo'),
        onRedo: () => applyHistoryAction('redo'),
        captureHistorySnapshot,
        handleInput,
    });

    return (
        <div
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
            className="rich-text-input-shell"
        >
            <div
                ref={refCallback}
                contentEditable={!readOnly}
                role="textbox"
                aria-label={ariaLabel ?? placeholder}
                aria-multiline="true"
                aria-readonly={readOnly}
                aria-autocomplete={ariaControls ? 'list' : undefined}
                aria-controls={ariaControls}
                aria-activedescendant={ariaActiveDescendant}
                aria-expanded={ariaExpanded}
                inputMode="text"
                autoCorrect={autoCorrect}
                spellCheck={spellCheck}
                onBeforeInput={captureHistorySnapshot}
                onInput={handleInput}
                onClick={handleClick}
                onKeyDown={handleKeyDownInternal}
                onPaste={handlePaste}
                onFocus={onFocus}
                onBlur={onBlur}
                onPointerDown={onPointerDown}
                className={`rich-text-input-editor${className ? ` ${className}` : ''}`}
                data-placeholder={!value ? placeholder : ''}
                suppressContentEditableWarning
                style={style}
            >
                {initialContentRef.current
                    ? renderInitialRichText(initialContentRef.current.text, initialContentRef.current.knownProjects)
                    : undefined}
            </div>
        </div>
    );
});
