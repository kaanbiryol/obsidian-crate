import React from 'react';
import type { RichTextInputHandle } from '../../components/RichTextInput';
import type { RecurrenceRule } from '../../types';
import { ReminderActionChips } from './ReminderActionChips';
import { ReminderEditorFields } from './ReminderEditorFields';

interface AddReminderModalBodyProps {
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
    onTouchEnd: () => void;
    dueDate: string | null;
    hasTime?: boolean;
    project: string;
    defaultProject: string;
    priority: number;
    recurrence?: RecurrenceRule;
    dueDateChanged: boolean;
    projectChanged: boolean;
    hasMounted: boolean;
    onOpenDatePicker: () => void;
    onOpenProjectPicker: () => void;
    onOpenRecurrencePicker: () => void;
    onTogglePriority: () => void;
}

export const AddReminderModalBody: React.FC<AddReminderModalBodyProps> = ({
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
    onTouchEnd,
    dueDate,
    hasTime,
    project,
    defaultProject,
    priority,
    recurrence,
    dueDateChanged,
    projectChanged,
    hasMounted,
    onOpenDatePicker,
    onOpenProjectPicker,
    onOpenRecurrencePicker,
    onTogglePriority,
}) => {
    return (
        <div className="px-5 pt-3 pb-3" onTouchEnd={onTouchEnd}>
            <ReminderEditorFields
                isEditing={isEditing}
                isDark={isDark}
                textColor={textColor}
                content={content}
                onContentChange={onContentChange}
                description={description}
                onDescriptionChange={onDescriptionChange}
                onKeyDown={onKeyDown}
                allowAutoFocus={allowAutoFocus}
                preserveSelection={preserveSelection}
                projects={projects}
                textareaRef={textareaRef}
                richTextInputRef={richTextInputRef}
            />

            <ReminderActionChips
                isDark={isDark}
                dueDate={dueDate}
                hasTime={hasTime}
                project={project}
                defaultProject={defaultProject}
                priority={priority}
                recurrence={recurrence}
                dueDateChanged={dueDateChanged}
                projectChanged={projectChanged}
                hasMounted={hasMounted}
                onOpenDatePicker={onOpenDatePicker}
                onOpenProjectPicker={onOpenProjectPicker}
                onOpenRecurrencePicker={onOpenRecurrencePicker}
                onTogglePriority={onTogglePriority}
            />
        </div>
    );
};
