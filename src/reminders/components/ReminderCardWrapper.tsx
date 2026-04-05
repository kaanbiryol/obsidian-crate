/**
 * Plugin Wrapper for ReminderCard
 *
 * Adapts the shared ReminderCard component to the plugin's API with platform-specific behavior:
 * - animations disabled (parent handles animations via Framer Motion)
 * - Integrates with plugin storage and modal system
 */
import { Notice } from 'obsidian';
import React, { useRef, useEffect } from 'react';
import { ReminderCard as SharedReminderCard, createLogger } from '@/reminders';

const log = createLogger('ReminderCardWrapper');
import type { Reminder } from '@/reminders/types/plugin-reminder';
import { PluginContext } from '@/reminders/ui/reminders-context';
import { openReminderEditModal } from '@/reminders/ui/modals';

interface ReminderCardWrapperProps {
  reminder: Reminder;
  onUpdate?: () => void;
  onToggleCompleteOverride?: () => Promise<void> | void;
  onEditOverride?: () => void;
  index?: number;
  hideProject?: boolean;
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
}) => {
  const plugin = PluginContext.use();

  // Ref for native event listener (React events don't work in Shadow DOM)
  const wrapperRef = useRef<HTMLDivElement>(null);

  /**
   * Handle reminder completion toggle
   * Optimistic updates are handled by ReminderIndex
   */
  const handleToggle = async () => {
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
  };

  /**
   * Handle reminder edit
   */
  const handleEdit = () => {
    if (onEditOverride) {
      onEditOverride();
      return;
    }
    openReminderEditModal(plugin, reminder, onUpdate ?? (() => undefined));
  };

  // Native click handler for Shadow DOM compatibility
  // React's synthetic events don't work properly inside Shadow DOM
  // Use capture phase to intercept before HeroUI's handlers can stop propagation
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Handle checkbox clicks (premium checkbox or legacy HeroUI checkbox)
      if (target.closest('.premium-checkbox') || target.closest('[data-slot="wrapper"]') || target.closest('input[type="checkbox"]')) {
        e.stopPropagation();
        void handleToggle();
        return;
      }

      // Allow markdown link clicks to open in browser (don't open edit modal)
      if (target.closest('a[data-markdown-link]')) {
        e.stopPropagation();
        return;
      }

      // Handle card clicks (edit)
      handleEdit();
    };

    wrapper.addEventListener('click', handleClick, true);
    return () => wrapper.removeEventListener('click', handleClick, true);
  }, [plugin, reminder, onUpdate, onEditOverride]);

  return (
    <div
      ref={wrapperRef}
      className="sidebar-reminder-card-wrapper"
      style={{ cursor: 'pointer' }}
    >
      <SharedReminderCard
        reminder={{
          id: reminder.id,
          content: reminder.content,
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
      />
    </div>
  );
};
