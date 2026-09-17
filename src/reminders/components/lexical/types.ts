import type React from 'react';

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

export interface RichTextInputProps {
    /** Descriptions support links without interpreting reminder metadata. */
    markers?: boolean;
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
