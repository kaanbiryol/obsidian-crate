/**
 * Plugin Wrapper for ReminderCard
 *
 * Adapts the shared ReminderCard component to the plugin's API with platform-specific behavior:
 * - animations disabled (parent handles animations via Framer Motion)
 * - Integrates with the reminder repository and modal system
 */
import { Notice } from 'obsidian';
import React, { useCallback, useRef } from 'react';
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
  const isTogglingRef = useRef(false);

  /**
   * Handle reminder completion toggle
   * Optimistic updates are handled by ReminderIndex
   */
  const handleToggle = useCallback(async () => {
    if (isTogglingRef.current) return;
    isTogglingRef.current = true;

    if (onToggleCompleteOverride) {
      try {
        await onToggleCompleteOverride();
        onUpdate?.();
        return;
      } finally {
        isTogglingRef.current = false;
      }
    }

    try {
      if (reminder.completed) {
        await plugin.reminderRepository.uncomplete(reminder.id);
      } else {
        await plugin.reminderRepository.complete(reminder.id);
      }
    } catch (error) {
      log.error('Failed to toggle reminder', error);
      new Notice('Failed to update reminder');
    } finally {
      isTogglingRef.current = false;
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
        reminder={{
          id: reminder.id,
          content: reminder.content,
          description: reminder.description,
          completed: reminder.completed,
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
};
