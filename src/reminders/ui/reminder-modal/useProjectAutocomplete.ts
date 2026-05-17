import { useState, useCallback, useMemo, useEffect } from 'react';
import type React from 'react';

import { filterProjects, extractHashtagQuery } from '../../utils/projectSearch';
import type { RichTextInputHandle } from '../../components/RichTextInput';

const MAX_RESULTS = 10;

interface UseProjectAutocompleteOptions {
    content: string;
    projects: string[];
    onContentChange: (content: string) => void;
    richTextInputRef: React.RefObject<RichTextInputHandle | null>;
}

export function useProjectAutocomplete({
    content,
    projects,
    onContentChange,
    richTextInputRef,
}: UseProjectAutocompleteOptions) {
    const [query, setQuery] = useState<string | null>(null);
    const [rect, setRect] = useState<DOMRect | null>(null);
    const [highlightedIndex, setHighlightedIndex] = useState(0);

    const filteredProjects = useMemo(() => {
        if (query === null) return [];
        return filterProjects(projects, query).slice(0, MAX_RESULTS);
    }, [projects, query]);

    const isOpen = query !== null && filteredProjects.length > 0;

    // Reset highlighted index when query or results change
    useEffect(() => {
        setHighlightedIndex(0);
    }, [query]);

    const updateAutocomplete = useCallback((q: string | null, r: DOMRect | null) => {
        setQuery(q);
        setRect(r);
    }, []);

    const dismiss = useCallback(() => {
        setQuery(null);
        setRect(null);
    }, []);

    const selectProject = useCallback((project: string) => {
        // Get cursor offset from the RichTextInput element
        const el = richTextInputRef.current?.getElement();
        if (!el) {
            dismiss();
            return;
        }

        // Save current cursor position to find the hashtag
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) {
            dismiss();
            return;
        }

        // Get plain text and cursor offset
        const range = sel.getRangeAt(0);
        const preCaretRange = range.cloneRange();
        preCaretRange.selectNodeContents(el);
        preCaretRange.setEnd(range.endContainer, range.endOffset);
        const offset = preCaretRange.toString().length;

        // Extract plain text
        const getText = (node: Node): string => {
            if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
            if (node.nodeName === 'BR') return '\n';
            let text = '';
            node.childNodes.forEach(child => { text += getText(child); });
            return text;
        };
        const plainText = getText(el);

        const hashInfo = extractHashtagQuery(plainText, offset);
        if (!hashInfo) {
            dismiss();
            return;
        }

        const before = content.substring(0, hashInfo.startIndex);
        const after = content.substring(hashInfo.startIndex + 1 + (query?.length ?? 0));
        const replacement = `#${project} `;
        const newContent = before + replacement + after;
        const newCursorOffset = hashInfo.startIndex + replacement.length;

        // Set pending cursor position before updating content
        richTextInputRef.current?.setCursorPosition(newCursorOffset);
        onContentChange(newContent);
        dismiss();
    }, [content, query, richTextInputRef, onContentChange, dismiss]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
        if (!isOpen) return false;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setHighlightedIndex(i => Math.min(i + 1, filteredProjects.length - 1));
                return true;
            case 'ArrowUp':
                e.preventDefault();
                setHighlightedIndex(i => Math.max(i - 1, 0));
                return true;
            case 'Enter':
            case 'Tab': {
                e.preventDefault();
                const project = filteredProjects[highlightedIndex];
                if (project) selectProject(project);
                return true;
            }
            case 'Escape':
                e.preventDefault();
                dismiss();
                return true;
            default:
                return false;
        }
    }, [isOpen, filteredProjects, highlightedIndex, selectProject, dismiss]);

    return {
        query,
        rect,
        filteredProjects,
        highlightedIndex,
        isOpen,
        updateAutocomplete,
        handleKeyDown,
        selectProject,
        dismiss,
    };
}
