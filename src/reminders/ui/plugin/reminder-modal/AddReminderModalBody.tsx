import React, { useCallback } from 'react';
import { PluginContext } from '../reminders-context';
import { PageTitleContext } from '../../shared/lexical/pageTitles';
import type { RichTextInputHandle } from '../../shared/RichTextInput';
import type { ReminderDraft } from './useReminderDraft';
import { getProjectColor } from '../../format/projectColors';
import { ReminderActionChips } from '../../reminder-editor/ReminderActionChips';
import { PluginReminderEditorFields as ReminderEditorFields } from '../PluginReminderEditorFields';

interface AddReminderModalBodyProps {
    isDark: boolean;
    draft: ReminderDraft;
    onKeyDown: (event: React.KeyboardEvent) => void;
    allowAutoFocus: boolean;
    projects: string[];
    textareaRef: React.RefObject<HTMLDivElement | null>;
    richTextInputRef: React.RefObject<RichTextInputHandle | null>;
    descriptionInputRef: React.RefObject<RichTextInputHandle | null>;
    defaultProject: string;
    onOpenDatePicker: () => void;
    onOpenProjectPicker: () => void;
    onOpenRecurrencePicker: () => void;
    onTogglePriority: () => void;
}

export const AddReminderModalBody: React.FC<AddReminderModalBodyProps> = ({
    isDark,
    draft,
    onKeyDown,
    allowAutoFocus,
    projects,
    textareaRef,
    richTextInputRef,
    descriptionInputRef,
    defaultProject,
    onOpenDatePicker,
    onOpenProjectPicker,
    onOpenRecurrencePicker,
    onTogglePriority,
}) => {
    const plugin = PluginContext.use();
    // A replaced connection rejects, which the editor treats as no title.
    const resolvePageTitle = useCallback((url: string) =>
        plugin.syncRuntime.withCurrentApi(api => api.fetchPageTitle(url), 'Sync connection changed.'), [plugin]);
    const projectColor = getProjectColor(draft.project || defaultProject)[isDark ? 'dark' : 'light'].accent;

    return (
        <div
            className="reminder-modal-body"
            data-base-ui-swipe-ignore=""
            style={{ '--reminder-project-color': projectColor } as React.CSSProperties}
        >
            <PageTitleContext.Provider value={plugin.syncRuntime.getApiClient() ? resolvePageTitle : undefined}>
                <ReminderEditorFields
                    content={draft.content}
                    onContentChange={draft.setContent}
                    description={draft.description}
                    onDescriptionChange={draft.setDescription}
                    onKeyDown={onKeyDown}
                    allowAutoFocus={allowAutoFocus}
                    projects={projects}
                    isDark={isDark}
                    textareaRef={textareaRef}
                    richTextInputRef={richTextInputRef}
                    descriptionInputRef={descriptionInputRef}
                />
            </PageTitleContext.Provider>

            <ReminderActionChips
                dueDate={draft.dueDate}
                hasTime={draft.hasTime}
                project={draft.project}
                defaultProject={defaultProject}
                priority={draft.priority}
                recurrence={draft.recurrence}
                onOpenDatePicker={onOpenDatePicker}
                onOpenProjectPicker={onOpenProjectPicker}
                onOpenRecurrencePicker={onOpenRecurrencePicker}
                onTogglePriority={onTogglePriority}
            />
        </div>
    );
};
