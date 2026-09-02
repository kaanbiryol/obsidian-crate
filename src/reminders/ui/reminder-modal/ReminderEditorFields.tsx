import React, { useCallback, useRef } from 'react';
import { ProjectAutocompleteDropdown } from './ProjectAutocompleteDropdown';
import { RichTextInput, type RichTextInputHandle } from '../../components/RichTextInput';
import { useProjectAutocomplete } from './useProjectAutocomplete';
import { autosizeTextarea, useAutosizeTextarea } from './useAutosizeTextarea';
import { useBottomFade } from './useBottomFade';

interface ReminderEditorFieldsProps {
    content: string;
    onContentChange: (value: string) => void;
    description: string;
    onDescriptionChange: (value: string) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    allowAutoFocus: boolean;
    projects: string[];
    textareaRef: React.RefObject<HTMLDivElement | null>;
    richTextInputRef: React.RefObject<RichTextInputHandle | null>;
}

export function ReminderEditorFields({
    content,
    onContentChange,
    description,
    onDescriptionChange,
    onKeyDown,
    allowAutoFocus,
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
            className="reminder-editor-fields relative"
        >
            <RichTextInput
                ref={richTextInputRef}
                value={content}
                onChange={onContentChange}
                onKeyDown={onKeyDown}
                placeholder="Reminder title"
                inputRef={textareaRef}
                autoFocus={allowAutoFocus}
                knownProjects={projects}
                onAutocompleteQuery={handleAutocompleteQuery}
                onAutocompleteKeyDown={autocomplete.handleKeyDown}
                ariaControls={autocomplete.isOpen ? 'project-autocomplete-listbox' : undefined}
                ariaActiveDescendant={autocomplete.isOpen
                    ? `project-autocomplete-option-${autocomplete.highlightedIndex}`
                    : undefined}
                ariaExpanded={autocomplete.isOpen}
                className={`reminder-title-input ios-scroll${titleFade ? ' has-bottom-fade' : ''}`}
            />
            {autocomplete.isOpen && (
                <ProjectAutocompleteDropdown
                    filteredProjects={autocomplete.filteredProjects}
                    highlightedIndex={autocomplete.highlightedIndex}
                    anchorRect={autocomplete.rect}
                    containerRef={containerRef}
                    onSelect={autocomplete.selectProject}
                />
            )}

            <div className="reminder-description-wrap">
                <textarea
                    ref={descriptionRef}
                    value={description}
                    onChange={(event) => onDescriptionChange(event.target.value)}
                    placeholder="Description"
                    rows={1}
                    className={`reminder-description-input ios-scroll${descFade ? ' has-bottom-fade' : ''}`}
                    onInput={(event) => autosizeTextarea(event.currentTarget)}
                />
            </div>
        </div>
    );
}
