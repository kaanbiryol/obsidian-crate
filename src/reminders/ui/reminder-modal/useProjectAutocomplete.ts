import { useState, useCallback, useMemo, useEffect } from 'react';
import type React from 'react';

import { filterProjects, extractHashtagQuery } from '../../utils/projectSearch';
import { getPlainText } from '../../utils/richTextPlainText';
import { saveCursorPosition } from '../../utils/cursorPosition';
import { replaceReminderProject, toReminderTextOffset, toReminderCursorOffset } from '../../utils/reminderEditorEdits';
import type { RichTextInputHandle } from '../../components/RichTextInput';

const MAX_RESULTS = 10;

interface UseProjectAutocompleteOptions {
    content: string;
    projects: string[];
    onContentChange: (content: string) => void;
    richTextInputRef: React.RefObject<RichTextInputHandle | null>;
}

export function useProjectAutocomplete({
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

        const plainText = getPlainText(el);
        const cursor = saveCursorPosition(el);
        if (cursor === null) {
            dismiss();
            return;
        }
        const offset = toReminderTextOffset(plainText, cursor);

        const hashInfo = extractHashtagQuery(plainText, offset);
        if (!hashInfo) {
            dismiss();
            return;
        }

        const next = replaceReminderProject(
            plainText, hashInfo.startIndex, offset - hashInfo.startIndex, project, projects,
        );
        richTextInputRef.current?.setCursorPosition(toReminderCursorOffset(next.text, next.cursor));
        onContentChange(next.text);
        dismiss();
    }, [projects, richTextInputRef, onContentChange, dismiss]);

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
