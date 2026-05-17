import React, { useCallback, useRef } from 'react';
import { ProjectAutocompleteDropdown } from './ProjectAutocompleteDropdown';
import { RichTextInput, type RichTextInputHandle } from '../../components/RichTextInput';
import { useProjectAutocomplete } from './useProjectAutocomplete';
import { getFontSize } from '../themes';
import { autosizeTextarea, useAutosizeTextarea } from './useAutosizeTextarea';
import { useBottomFade } from './useBottomFade';

const FADE_MASK = 'linear-gradient(to bottom, black calc(100% - 40px), transparent)';
const NO_FADE: React.CSSProperties = {};
const FADE_STYLE: React.CSSProperties = {
    maskImage: FADE_MASK,
    WebkitMaskImage: FADE_MASK,
};

interface ReminderEditorFieldsProps {
    isEditing: boolean;
    isDark: boolean;
    textColor: string;
    content: string;
    onContentChange: (value: string) => void;
    description: string;
    onDescriptionChange: (value: string) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    allowAutoFocus: boolean;
    preserveSelection: boolean;
    projects: string[];
    textareaRef: React.RefObject<HTMLDivElement | null>;
    richTextInputRef: React.RefObject<RichTextInputHandle | null>;
}

export function ReminderEditorFields({
    isEditing,
    isDark,
    textColor,
    content,
    onContentChange,
    description,
    onDescriptionChange,
    onKeyDown,
    allowAutoFocus,
    preserveSelection,
    projects,
    textareaRef,
    richTextInputRef,
}: ReminderEditorFieldsProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const descriptionRef = useRef<HTMLTextAreaElement>(null);
    const titleFade = useBottomFade(textareaRef);
    const descFade = useBottomFade(descriptionRef);

    useAutosizeTextarea(descriptionRef, Boolean(description));

    const autocomplete = useProjectAutocomplete({
        content,
        projects,
        onContentChange,
        richTextInputRef,
    });

    const handleAutocompleteQuery = useCallback((query: string | null, rect: DOMRect | null) => {
        autocomplete.updateAutocomplete(query, rect);
    }, [autocomplete.updateAutocomplete]);

    return (
        <div
            ref={containerRef}
            className="relative rounded-lg"
            style={{
                backgroundColor: isDark ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.02)',
                border: isDark ? '1px solid rgba(255, 255, 255, 0.04)' : '1px solid rgba(0, 0, 0, 0.03)',
                padding: '12px 14px',
            }}
        >
            <RichTextInput
                ref={richTextInputRef}
                value={content}
                onChange={onContentChange}
                onKeyDown={onKeyDown}
                placeholder={isEditing ? "Edit your reminder..." : "What do you need to remember?"}
                inputRef={textareaRef}
                autoFocus={allowAutoFocus}
                preserveSelection={preserveSelection}
                knownProjects={projects}
                onAutocompleteQuery={handleAutocompleteQuery}
                onAutocompleteKeyDown={autocomplete.handleKeyDown}
                className="w-full px-0 py-0 bg-transparent border-none outline-none resize-none min-h-[32px] ios-scroll"
                style={{
                    fontSize: getFontSize('lg'),
                    color: textColor,
                    maxHeight: '100px',
                    overflowY: 'auto',
                    ...(titleFade ? FADE_STYLE : NO_FADE),
                }}
            />
            {autocomplete.isOpen && (
                <ProjectAutocompleteDropdown
                    filteredProjects={autocomplete.filteredProjects}
                    highlightedIndex={autocomplete.highlightedIndex}
                    anchorRect={autocomplete.rect}
                    containerRef={containerRef}
                    isDark={isDark}
                    onSelect={autocomplete.selectProject}
                />
            )}

            <div
                style={{
                    marginTop: '8px',
                    paddingTop: '8px',
                    borderTop: isDark
                        ? '1px solid rgba(255, 255, 255, 0.04)'
                        : '1px solid rgba(0, 0, 0, 0.04)',
                }}
            >
                <textarea
                    ref={descriptionRef}
                    value={description}
                    onChange={(event) => onDescriptionChange(event.target.value)}
                    placeholder="Add description..."
                    rows={1}
                    className="ios-scroll focus:outline-none focus:ring-0 focus:shadow-none"
                    style={{
                        display: 'block',
                        width: '100%',
                        padding: 0,
                        background: 'transparent',
                        border: 'none',
                        outline: 'none',
                        boxShadow: 'none',
                        WebkitAppearance: 'none',
                        resize: 'none',
                        fontSize: '13px',
                        lineHeight: 1.5,
                        color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)',
                        caretColor: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)',
                        fontFamily: 'inherit',
                        maxHeight: '120px',
                        overflowY: 'auto',
                        ...(descFade ? FADE_STYLE : NO_FADE),
                    }}
                    onInput={(event) => autosizeTextarea(event.currentTarget)}
                />
            </div>
        </div>
    );
}
