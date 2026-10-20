import React, { useCallback } from 'react';
import { PluginContext } from '../reminders-context';
import { PageTitleContext } from '../../shared/lexical/pageTitles';
import type { RichTextInputHandle } from '../../shared/RichTextInput';
import type { ReminderDraft } from './useReminderDraft';
import { getProjectColor } from '../../format/projectColors';
import { ReminderActionChips } from '../../reminder-modal/ReminderActionChips';
import { PluginReminderEditorFields as ReminderEditorFields } from '../PluginReminderEditorFields';
import { ThemeIconProvider } from '../../../../ui/shared/ThemeIcon';
import { ObsidianIcon } from '../../../../ui/obsidian-icon';

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
    const resolvePageTitle = useCallback(async (url: string) => {
        const api = plugin.syncRuntime.getApiClient();
        const title = await api?.fetchPageTitle(url) ?? null;
        return api === plugin.syncRuntime.getApiClient() ? title : null;
    }, [plugin]);
    const projectColor = getProjectColor(draft.project || defaultProject)[isDark ? 'dark' : 'light'].accent;

    return (
        <ThemeIconProvider renderer={ObsidianIcon}>
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
        </ThemeIconProvider>
    );
};
