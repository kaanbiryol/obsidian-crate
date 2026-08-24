import React, { useRef, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react';
import { buildHTML, getPlainText } from '../utils/richTextParsing';
import { saveCursorPosition, restoreCursorPosition, moveCursorToEnd } from '../utils/cursorPosition';
import { extractHashtagQuery } from '../utils/projectSearch';
import {
    focusRichTextElement,
    renderRichText,
    selectElementContents,
} from './richTextInputDom';
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
    inputRef?: React.RefObject<HTMLDivElement | null>;
    className?: string;
    style?: React.CSSProperties;
    autoFocus?: boolean;
    readOnly?: boolean;
    /** Preserve cursor position when value is updated externally */
    preserveSelection?: boolean;
    /** Known project names for multi-word project highlighting */
    knownProjects?: string[];
    /** Callback when a # autocomplete query changes. null = no active autocomplete. */
    onAutocompleteQuery?: (query: string | null, rect: DOMRect | null) => void;
    /** Handler for autocomplete keyboard navigation. Return true if handled. */
    onAutocompleteKeyDown?: (e: React.KeyboardEvent) => boolean;
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
    inputRef,
    className,
    style,
    autoFocus = false,
    readOnly = false,
    preserveSelection = true,
    knownProjects,
    onAutocompleteQuery,
    onAutocompleteKeyDown
}, ref) => {
    const editableRef = useRef<HTMLDivElement>(null);
    const hasInitializedRef = useRef(false);
    const knownProjectsKeyRef = useRef<string | null>(null);
    const pendingCursorRef = useRef<number | null>(null);
    const pendingScrollTopRef = useRef<number | null>(null);
    const restoreRequestIdRef = useRef(0);

    // Use provided ref or internal one
    const actualRef = inputRef || editableRef;

    // Ref callback to update refs when element attaches to DOM
    const refCallback = useCallback((el: HTMLDivElement | null) => {
        if (inputRef) {
            inputRef.current = el;
        } else {
            editableRef.current = el;
        }
    }, [inputRef]);

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

    const scheduleSelectionRestore = useCallback((position: number | null, afterRestore?: () => void) => {
        const requestId = ++restoreRequestIdRef.current;
        requestAnimationFrame(() => {
            if (restoreRequestIdRef.current !== requestId || !actualRef.current) {
                return;
            }

            restoreCursorPosition(actualRef.current, position);
            afterRestore?.();
        });
    }, [actualRef]);

    // Handle input changes
    const handleInput = () => {
        if (readOnly || !actualRef.current) return;

        const cursorPos = saveCursorPosition(actualRef.current);
        const plainText = getPlainText(actualRef.current);

        // Build and render HTML with chips
        const html = buildHTML(plainText, knownProjects);
        const normalizedHtml = html || '';
        const shouldRerender = actualRef.current.innerHTML !== normalizedHtml;
        if (shouldRerender) {
            renderRichText(actualRef.current, normalizedHtml);
        }

        // Call onChange with plain text
        onChange(plainText);

        const updateAutocompleteQuery = () => {
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
        };

        if (shouldRerender) {
            scheduleSelectionRestore(cursorPos, updateAutocompleteQuery);
            return;
        }

        updateAutocompleteQuery();
    };

    // Update content when value changes externally (e.g., from parent reset)
    useEffect(() => {
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

        if (actualRef.current.innerHTML === normalizedHtml) {
            return;
        }

        const isFocused = document.activeElement === actualRef.current;
        const shouldPreserveCursor = preserveSelection && isFocused;
        const cursorPos = shouldPreserveCursor ? saveCursorPosition(actualRef.current) : null;

        renderRichText(actualRef.current, normalizedHtml);

        // If autoFocus is enabled and this is initial content, move cursor to end
        if (autoFocus && !hasInitializedRef.current && value) {
            hasInitializedRef.current = true;
            requestAnimationFrame(() => {
                if (actualRef.current) {
                    moveCursorToEnd(actualRef.current);
                }
            });
            return;
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
            scheduleSelectionRestore(cursorPos);
        }
    }, [value, autoFocus, knownProjects, preserveSelection, scheduleSelectionRestore]);

    // Handle auto-focus on mount (more reliable than HTML autoFocus for contentEditable)
    useEffect(() => {
        if (autoFocus && actualRef.current) {
            // Small delay to ensure modal is fully rendered
            const timer = setTimeout(() => {
                if (!actualRef.current) return;
                if (document.activeElement !== actualRef.current) {
                    actualRef.current.focus();
                }
                // If there's no content, still need to set cursor position
                if (!getPlainText(actualRef.current)) {
                    moveCursorToEnd(actualRef.current);
                }
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [autoFocus]);

    const {
        handleClick,
        handleKeyDownInternal,
        handlePaste,
        handleMouseDown,
        handleTouchStart,
    } = useRichTextInputInteractions({
        onKeyDown,
        onAutocompleteKeyDown,
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
                inputMode="text"
                autoFocus={autoFocus}
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
            />
        </div>
    );
});
