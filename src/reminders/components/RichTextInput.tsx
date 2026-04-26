import React, { useRef, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react';
import { buildHTML, getPlainText } from '../utils/richTextParsing';
import { saveCursorPosition, restoreCursorPosition, moveCursorToEnd } from '../utils/cursorPosition';
import { extractHashtagQuery } from '../utils/projectSearch';

function renderRichText(element: HTMLDivElement, html: string): void {
    if (!html) {
        element.replaceChildren();
        return;
    }

    const range = document.createRange();
    range.selectNodeContents(element);
    const fragment = range.createContextualFragment(html);
    element.replaceChildren(fragment);
}

function insertPlainTextAtSelection(text: string): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return;
    }

    const range = selection.getRangeAt(0);
    range.deleteContents();

    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const fragment = document.createDocumentFragment();
    let lastInsertedNode: Node | null = null;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        if (line) {
            const textNode = document.createTextNode(line);
            fragment.append(textNode);
            lastInsertedNode = textNode;
        }

        if (index < lines.length - 1) {
            const lineBreak = document.createElement('br');
            fragment.append(lineBreak);
            lastInsertedNode = lineBreak;
        }
    }

    if (!lastInsertedNode) {
        return;
    }

    range.insertNode(fragment);

    const nextRange = document.createRange();
    if (lastInsertedNode instanceof Text) {
        nextRange.setStart(lastInsertedNode, lastInsertedNode.textContent?.length ?? 0);
    } else {
        nextRange.setStartAfter(lastInsertedNode);
    }
    nextRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(nextRange);
}

function selectElementContents(element: HTMLElement): void {
    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
}

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
    setCursorPosition: (pos: number) => void;
}

interface RichTextInputProps {
    value: string;
    onChange: (value: string) => void;
    onKeyDown?: (e: React.KeyboardEvent) => void;
    onFocus?: (e: React.FocusEvent) => void;
    onBlur?: (e: React.FocusEvent) => void;
    placeholder?: string;
    inputRef?: React.RefObject<HTMLDivElement | null>;
    className?: string;
    style?: React.CSSProperties;
    autoFocus?: boolean;
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
    placeholder,
    inputRef,
    className,
    style,
    autoFocus = false,
    preserveSelection = true,
    knownProjects,
    onAutocompleteQuery,
    onAutocompleteKeyDown
}, ref) => {
    const editableRef = useRef<HTMLDivElement>(null);
    const hasInitializedRef = useRef(false);
    const knownProjectsKeyRef = useRef<string | null>(null);
    const pendingCursorRef = useRef<number | null>(null);
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
                actualRef.current.focus({ preventScroll: true });
                // Delay cursor positioning to allow focus to stabilize
                requestAnimationFrame(() => {
                    if (actualRef.current) {
                        if (options.select) {
                            selectElementContents(actualRef.current);
                        } else {
                            moveCursorToEnd(actualRef.current);
                        }
                    }
                });
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
        setCursorPosition: (pos: number) => {
            pendingCursorRef.current = pos;
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
        if (!actualRef.current) return;

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
            pendingCursorRef.current = null;
            scheduleSelectionRestore(pendingPos);
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

    // Handle link clicks in contentEditable: Cmd/Ctrl+Click opens the URL, regular click positions cursor
    const handleClick = useCallback((e: React.MouseEvent) => {
        const target = e.target as HTMLElement;
        const linkEl = target.closest('a[data-markdown-link]');
        if (linkEl instanceof HTMLAnchorElement) {
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) {
                const url = linkEl.getAttribute('href');
                if (url) {
                    window.open(url, '_blank', 'noopener,noreferrer');
                }
            }
        }
    }, []);

    // Handle keydown - autocomplete gets first chance to consume the event
    const handleKeyDownInternal = (e: React.KeyboardEvent) => {
        if (onAutocompleteKeyDown?.(e)) return;
        if (onKeyDown) {
            onKeyDown(e);
        }
    };

    // Handle paste - strip formatting
    const handlePaste = (e: React.ClipboardEvent) => {
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        insertPlainTextAtSelection(text);
        handleInput();
    };

    // Prevent focus loss when clicking interactive elements (buttons, pills) inside the modal
    // This fixes iOS issue where contentEditable loses focus when tapping buttons
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        const target = e.target as HTMLElement;
        // If clicking on an interactive element, prevent default blur behavior
        if (target.closest('button, [role="button"], .pill, [data-slot="base"]')) {
            e.preventDefault();
        }
    }, []);

    // Same for touch events on iOS
    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('button, [role="button"], .pill, [data-slot="base"]')) {
            // Don't prevent default here as it would break button interaction
            // Instead, we'll restore focus in the button's onPress handler
        }
    }, []);

    return (
        <div
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
            style={{ position: 'relative' }}
        >
            <div
                ref={refCallback}
                contentEditable
                inputMode="text"
                autoFocus={autoFocus}
                onInput={handleInput}
                onClick={handleClick}
                onKeyDown={handleKeyDownInternal}
                onPaste={handlePaste}
                onFocus={onFocus}
                onBlur={onBlur}
                className={className}
                data-placeholder={!value ? placeholder : ''}
                suppressContentEditableWarning
                style={{
                    minHeight: '1.5rem',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    paddingTop: '0.25rem',
                    paddingBottom: '0.25rem',
                    lineHeight: '1.65',
                    ...style
                }}
            />
        </div>
    );
});
