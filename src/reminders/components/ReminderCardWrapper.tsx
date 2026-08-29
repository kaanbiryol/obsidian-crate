/**
 * Plugin Wrapper for ReminderCard
 *
 * Adapts the shared ReminderCard component to the plugin's API with platform-specific behavior:
 * - animations disabled (parent handles animations via Framer Motion)
 * - Integrates with plugin storage and modal system
 */
import { Notice } from 'obsidian';
import React, { useCallback } from 'react';
import { ReminderCard as SharedReminderCard } from '@/reminders/components/ReminderCard';
import { useReminderCardInteractions } from '@/reminders/components/useReminderCardInteractions';
import { createLogger } from '@/reminders/utils/logger';

const log = createLogger('ReminderCardWrapper');
import type { Reminder } from '@/reminders/types/plugin-reminder';
import { PluginContext } from '@/reminders/ui/reminders-context';
import { openReminderEditModal } from '@/reminders/ui/adapters/modals';
import type { ProjectColorScheme } from '@/reminders/utils/projectColors';

interface ReminderCardWrapperProps {
  reminder: Reminder;
  onUpdate?: () => void;
  onToggleCompleteOverride?: () => Promise<void> | void;
  onEditOverride?: () => void;
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
export const ReminderCardWrapper: React.FC<ReminderCardWrapperProps> = ({
  reminder,
  onUpdate,
  onToggleCompleteOverride,
  onEditOverride,
  index,
  hideProject = false,
  colorScheme = 'dark',
}) => {
  const plugin = PluginContext.use();

  /**
   * Handle reminder completion toggle
   * Optimistic updates are handled by ReminderIndex
   */
  const handleToggle = useCallback(async () => {
    if (onToggleCompleteOverride) {
      await onToggleCompleteOverride();
      onUpdate?.();
      return;
    }

    try {
      const indexed = plugin.reminderIndex?.getById(reminder.id);
      if (indexed) {
        await plugin.markdownWriter.toggleComplete(indexed);
      } else {
        // Fallback to storage compatibility layer
        if (reminder.completed) {
          await plugin.storage.uncomplete(reminder.id);
        } else {
          await plugin.storage.complete(reminder.id);
        }
      }
    } catch (error) {
      log.error('Failed to toggle reminder', error);
      new Notice('Failed to update reminder');
    }
  }, [onToggleCompleteOverride, onUpdate, plugin, reminder.completed, reminder.id]);

  /**
   * Handle reminder edit
   */
  const handleEdit = useCallback(() => {
    if (onEditOverride) {
      onEditOverride();
      return;
    }
    openReminderEditModal(plugin, reminder, onUpdate ?? (() => undefined));
  }, [onEditOverride, onUpdate, plugin, reminder]);

  const wrapperRef = useReminderCardInteractions({
    onEdit: handleEdit,
    onToggleComplete: handleToggle,
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
        reminder={{
          id: reminder.id,
          content: reminder.content,
          description: reminder.description,
          completed: reminder.completed,
          dueDatetime: reminder.dueDatetime,
          dueDate: reminder.dueDate,
          priority: reminder.priority,
          project: reminder.project,
          updated_at: reminder.updatedAt,
          updatedAt: reminder.updatedAt,
          recurrence: reminder.recurrence,
        }}
        animationConfig={{ enabled: false }}
        index={index}
        hideProject={hideProject}
        colorScheme={colorScheme}
      />
    </div>
  );
};
