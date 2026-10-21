/**
 * Plugin Wrapper for ReminderCard
 *
 * Adapts the shared ReminderCard component to the plugin's API with platform-specific behavior:
 * - animations disabled (parent handles animations via Framer Motion)
 * - Integrates with the reminder repository and modal system
 */
import { Notice } from 'obsidian';
import React, { useCallback, useRef, useState } from 'react';
import { ReminderCard as SharedReminderCard } from '@/reminders/ui/shared/ReminderCard';
import { useReminderCardInteractions } from '@/reminders/ui/shared/useReminderCardInteractions';
import { createLogger } from '@/reminders/logger';

const log = createLogger('ReminderCardWrapper');
import type { Reminder } from '@/reminders/types/reminder';
import { PluginContext } from '@/reminders/ui/plugin/reminders-context';
import { openReminderEditModal } from '@/reminders/ui/plugin/reminderEditorModals';
import { requireReminderBackend } from '@/reminders/runtime';
import type { ProjectColorScheme } from '@/reminders/ui/format/projectColors';
import { useRemindersSettingsStore } from '@/reminders/settings';

interface ReminderCardWrapperProps {
  reminder: Reminder;
  onUpdate?: () => void;
  index?: number;
  hideProject?: boolean;
  colorScheme?: ProjectColorScheme;
}

/**
 * Plugin-specific wrapper for ReminderCard
 *
 * Provides Obsidian-specific handlers for toggle, delete, and edit operations.
 * Optimistic updates are handled by ReminderIndex.
 */
export const ReminderCardWrapper = React.memo(function ReminderCardWrapper({
  reminder,
  onUpdate,
  index,
  hideProject = false,
  colorScheme = 'dark',
}: ReminderCardWrapperProps) {
  const plugin = PluginContext.use();
  const listStyle = useRemindersSettingsStore(state => state.listStyle);
  const isTogglingRef = useRef(false);
  const [completionPreview, setCompletionPreview] = useState<{ source: Reminder; completed: boolean }>();

  /**
   * Handle reminder completion toggle
   * Optimistic updates are handled by ReminderIndex
   */
  const handleToggle = useCallback(async () => {
    if (isTogglingRef.current) return;
    isTogglingRef.current = true;
    // The exiting row keeps its old props. Give it immediate checkbox feedback,
    // and let the next repository snapshot take over without a timer or delay.
    setCompletionPreview({ source: reminder, completed: !reminder.completed });

    try {
      if (reminder.completed) {
        await requireReminderBackend(plugin).repository.uncomplete(reminder.id);
      } else {
        await requireReminderBackend(plugin).repository.complete(reminder.id);
      }
    } catch (error) {
      setCompletionPreview(undefined);
      log.error('Failed to toggle reminder', error);
      new Notice('Failed to update reminder');
    } finally {
      isTogglingRef.current = false;
    }
  }, [plugin, reminder]);

  /**
   * Handle reminder edit
   */
  const handleEdit = useCallback(() => {
    openReminderEditModal(plugin, reminder, onUpdate ?? (() => undefined));
  }, [onUpdate, plugin, reminder]);

  const wrapperRef = useReminderCardInteractions({
    onEdit: handleEdit,
    onToggleComplete: handleToggle,
    isDisabled: () => isTogglingRef.current,
  });

  return (
    <div
      ref={wrapperRef}
      className="sidebar-reminder-card-wrapper is-interactive"
      role="group"
      tabIndex={0}
      aria-label={`${reminder.content}. Press Enter to edit reminder.`}
    >
      <SharedReminderCard
        listStyle={listStyle}
        reminder={{
          id: reminder.id,
          content: reminder.content,
          description: reminder.description,
          completed: completionPreview?.source === reminder ? completionPreview.completed : reminder.completed,
          dueDatetime: reminder.dueDatetime,
          dueDate: reminder.dueDate,
          priority: reminder.priority,
          project: reminder.project,
          recurrence: reminder.recurrence,
        }}
        animationConfig={{ enabled: false }}
        index={index}
        hideProject={hideProject}
        colorScheme={colorScheme}
      />
    </div>
  );
});
