import React from 'react';
import type { RichTextInputHandle } from '../../components/RichTextInput';
import type { RecurrenceRule } from '../../types';
import { getProjectColor } from '../../utils/projectColors';
import { ReminderActionChips } from './ReminderActionChips';
import { ReminderEditorFields } from './ReminderEditorFields';

interface AddReminderModalBodyProps {
    isDark: boolean;
    content: string;
    onContentChange: (value: string) => void;
    description: string;
    onDescriptionChange: (value: string) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    allowAutoFocus: boolean;
    projects: string[];
    textareaRef: React.RefObject<HTMLDivElement | null>;
    richTextInputRef: React.RefObject<RichTextInputHandle | null>;
    dueDate: string | null;
    hasTime?: boolean;
    project: string;
    defaultProject: string;
    priority: number;
    recurrence?: RecurrenceRule;
    onOpenDatePicker: () => void;
    onOpenProjectPicker: () => void;
    onOpenRecurrencePicker: () => void;
    onTogglePriority: () => void;
}

export const AddReminderModalBody: React.FC<AddReminderModalBodyProps> = ({
    isDark,
    content,
    onContentChange,
    description,
    onDescriptionChange,
    onKeyDown,
    allowAutoFocus,
    projects,
    textareaRef,
    richTextInputRef,
    dueDate,
    hasTime,
    project,
    defaultProject,
    priority,
    recurrence,
    onOpenDatePicker,
    onOpenProjectPicker,
    onOpenRecurrencePicker,
    onTogglePriority,
}) => {
    const projectColor = getProjectColor(project || defaultProject)[isDark ? 'dark' : 'light'].accent;

    return (
        <div
            className="reminder-modal-body"
            style={{ '--reminder-project-color': projectColor } as React.CSSProperties}
        >
            <ReminderEditorFields
                content={content}
                onContentChange={onContentChange}
                description={description}
                onDescriptionChange={onDescriptionChange}
                onKeyDown={onKeyDown}
                allowAutoFocus={allowAutoFocus}
                projects={projects}
                textareaRef={textareaRef}
                richTextInputRef={richTextInputRef}
            />

            <ReminderActionChips
                dueDate={dueDate}
                hasTime={hasTime}
                project={project}
                defaultProject={defaultProject}
                priority={priority}
                recurrence={recurrence}
                onOpenDatePicker={onOpenDatePicker}
                onOpenProjectPicker={onOpenProjectPicker}
                onOpenRecurrencePicker={onOpenRecurrencePicker}
                onTogglePriority={onTogglePriority}
            />
        </div>
    );
};
