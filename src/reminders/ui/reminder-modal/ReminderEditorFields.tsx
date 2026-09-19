import { assertReminderMutationInput } from '../../core/reminderMutationInput';
import { parseReminderEditorContent } from '../../utils/reminderEditorParsing';
import React, { useRef, useMemo, useContext } from 'react';
import { PageTitleContext } from '../../components/lexical/pageTitles';
import { ProjectAutocompleteDropdown } from './ProjectAutocompleteDropdown';
import { RichTextInput, type RichTextInputHandle } from '../../components/RichTextInput';
import { useProjectAutocomplete } from './useProjectAutocomplete';

interface ReminderEditorFieldsProps {
    content: string;
    onContentChange: (value: string) => void;
    description: string;
    onDescriptionChange: (value: string) => void;
    onKeyDown?: (event: React.KeyboardEvent) => void;
    allowAutoFocus: boolean;
    projects: string[];
    textareaRef: React.RefObject<HTMLDivElement | null>;
    richTextInputRef: React.RefObject<RichTextInputHandle | null>;
    containerRef?: React.RefObject<HTMLDivElement | null>;
    descriptionRef?: React.RefObject<HTMLDivElement | null>;
    disabled?: boolean;
    titleInputProps?: Pick<React.ComponentProps<typeof RichTextInput>,
        'onFocus' | 'onBlur' | 'focusRequestKey' | 'preserveSelection' | 'externalChangeCursor'
        | 'syncContentBeforePaint' | 'autoComplete' | 'autoCorrect' | 'spellCheck' | 'className'>;
    descriptionInputProps?: Pick<React.ComponentProps<typeof RichTextInput>,
        'onFocus' | 'onBlur' | 'autoComplete' | 'autoCorrect' | 'spellCheck' | 'className'>;
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
    containerRef: externalContainerRef,
    descriptionRef: externalDescriptionRef,
    disabled = false,
    titleInputProps,
    descriptionInputProps,
}: ReminderEditorFieldsProps) {
    const resolvePageTitle = useContext(PageTitleContext);
    const localContainerRef = useRef<HTMLDivElement>(null);
    const localDescriptionRef = useRef<HTMLDivElement>(null);
    const containerRef = externalContainerRef ?? localContainerRef;
    const descriptionRef = externalDescriptionRef ?? localDescriptionRef;
    const inputError = useMemo(() => {
        try {
            assertReminderMutationInput({ content: content.trim() ? parseReminderEditorContent(content, projects).cleanContent || content : undefined, description }, 'update');
            return null;
        } catch (error) { return error instanceof Error ? error.message : 'Check the reminder fields.'; }
    }, [content, description, projects]);

    const autocomplete = useProjectAutocomplete({
        content,
        projects,
        onContentChange,
        richTextInputRef,
    });

    const handleAutocompleteQuery = autocomplete.updateAutocomplete;

    return (
        <div
            ref={containerRef}
            className="reminder-editor-fields relative"
        >
            {inputError && <p role="alert" style={{ color: 'var(--text-error, #d33)' }}>{inputError}</p>}
            <RichTextInput
                {...titleInputProps}
                resolvePageTitle={resolvePageTitle}
                readOnly={disabled}
                ariaLabel="Reminder title"
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
                className={`reminder-title-input ios-scroll ${titleInputProps?.className ?? ''}`}
            />
            {!disabled && autocomplete.isOpen && (
                <ProjectAutocompleteDropdown
                    filteredProjects={autocomplete.filteredProjects}
                    highlightedIndex={autocomplete.highlightedIndex}
                    anchorRect={autocomplete.rect}
                    containerRef={containerRef}
                    onSelect={autocomplete.selectProject}
                />
            )}

            <div className="reminder-description-wrap">
                <RichTextInput
                    {...descriptionInputProps}
                    resolvePageTitle={resolvePageTitle}
                    readOnly={disabled}
                    markers={false}
                    ariaLabel="Reminder description"
                    inputRef={descriptionRef}
                    value={description}
                    onChange={onDescriptionChange}
                    placeholder="Description"
                    className={`reminder-description-input ios-scroll ${descriptionInputProps?.className ?? ''}`}
                />
            </div>

        </div>
    );
}
