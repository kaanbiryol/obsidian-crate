import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { sortReminders, getUpcomingReminders, groupRemindersByDate, formatDateHeader, isReminderOverdue, STAGGERED_CARD_ANIMATION } from "@/reminders";

import type { Reminder } from "@/reminders/types/plugin-reminder";
import { indexedToReminder } from "@/reminders/data/reminderIndex";
import { PluginContext } from "@/reminders/ui/reminders-context";
import { useIndexRefresh } from "@/reminders/ui/hooks/useIndexRefresh";
import { ReminderCardWrapper } from "@/reminders/components/ReminderCardWrapper";
import { ShadowDOMButton } from "@/reminders/components/ShadowDOMButton";
import { ObsidianIcon } from "@/reminders/components/obsidian-icon";
import { openReminderCreationModal } from "@/reminders/ui/modals";
import "./styles.scss";

type Props = {
  projectFilter?: string; // If provided, only show reminders for this project
  showCompleted?: boolean;
  showToday?: boolean; // If true, only show reminders due today
  showUpcoming?: boolean; // If true, show upcoming reminders grouped by date
  onToggleShowCompleted?: (newValue: boolean) => void; // Persist showCompleted preference
};

export const RemindersList: React.FC<Props> = ({
  projectFilter,
  showCompleted = false,
  showToday = false,
  showUpcoming = false,
  onToggleShowCompleted,
}) => {
  const plugin = PluginContext.use();
  // Use setting default for upcoming days
  const effectiveDays = plugin.remindersSettings.upcomingDaysDefault ?? 7;
  const [showCompletedState, setShowCompletedState] = useState(showCompleted);

  // Subscribe to index changes for automatic refresh
  const { refreshToken, triggerRefresh } = useIndexRefresh();

  // State for reminders (needed because getAll is async when showCompleted is true)
  const [rawReminders, setRawReminders] = useState<Reminder[]>([]);

  // Load reminders - always use markdown index (markdown-first mode)
  useEffect(() => {
    const loadReminders = async () => {
      let loaded: Reminder[];

      if (plugin.reminderIndex?.isLoaded) {
        // Use markdown index (source of truth: markdown files)
        if (showToday) {
          // Get today's reminders plus overdue reminders
          const todayReminders = plugin.reminderIndex.getToday();
          const overdueReminders = plugin.reminderIndex.getOverdue();
          // Combine and deduplicate by id
          const todayAndOverdueMap = new Map<string, typeof todayReminders[0]>();
          for (const r of [...todayReminders, ...overdueReminders]) {
            todayAndOverdueMap.set(r.id, r);
          }
          let indexed = Array.from(todayAndOverdueMap.values());

          if (showCompletedState) {
            // Also include completed reminders from today
            const completedToday = plugin.reminderIndex.getCompleted().filter((r: any) => {
              const date = r.dueDatetime || r.dueDate;
              if (!date) return false;
              const today = new Date().toISOString().split("T")[0];
              return date.startsWith(today);
            });
            indexed = [...indexed, ...completedToday];
          }
          loaded = indexed.map(indexedToReminder);
        } else if (showUpcoming) {
          // Get all active reminders and filter for upcoming
          const allReminders = plugin.reminderIndex.getActive().map(indexedToReminder);
          loaded = getUpcomingReminders(allReminders, effectiveDays);
        } else if (showCompletedState) {
          loaded = plugin.reminderIndex.getAll().map(indexedToReminder);
        } else {
          loaded = plugin.reminderIndex.getActive().map(indexedToReminder);
        }
      } else {
        // Fallback to storage compatibility layer
        if (showToday) {
          loaded = plugin.storage.getTodayReminders(showCompletedState);
        } else if (showUpcoming) {
          // Get all active reminders and filter for upcoming
          const allReminders = plugin.storage.getActive();
          loaded = getUpcomingReminders(allReminders, effectiveDays);
        } else if (showCompletedState) {
          loaded = plugin.storage.getAll();
        } else {
          loaded = plugin.storage.getActive();
        }
      }
      setRawReminders(loaded);
    };
    loadReminders();
  }, [plugin, showToday, showUpcoming, effectiveDays, showCompletedState, refreshToken]);

  const reminders = useMemo(() => {
    let allReminders = [...rawReminders];

    // Filter by project if specified
    if (projectFilter) {
      const normalizedProject = projectFilter.toLowerCase().trim();
      allReminders = allReminders.filter(r => {
        const reminderProject = (r.project || "Inbox").toLowerCase();
        return reminderProject === normalizedProject;
      });
    }

    // Use shared sorting: completion status → due date → priority
    return sortReminders(allReminders);
  }, [
    rawReminders,
    projectFilter,
  ]);

  // Sync showCompleted prop to state when it changes (e.g., from widget update)
  useEffect(() => {
    setShowCompletedState(showCompleted);
  }, [showCompleted]);

  // Group reminders by date for upcoming view
  const dateGroups = useMemo(() => {
    if (!showUpcoming) return null;
    return groupRemindersByDate(reminders);
  }, [showUpcoming, reminders]);

  const activeCount = reminders.filter(r => !r.completed).length;
  const completedCount = reminders.filter(r => r.completed).length;
  const overdueCount = reminders.filter(r => isReminderOverdue(r)).length;

  const handleAdd = () => {
    openReminderCreationModal(
      plugin,
      projectFilter || "Inbox",
      () => {
        triggerRefresh();
      }
    );
  };

  return (
    <div className="reminders-list-container">
      <div className="reminders-list-header">
        <div className="reminders-count">
          {showToday && <span className="reminders-count-title">Today · </span>}
          {showUpcoming && <span className="reminders-count-title">Upcoming · </span>}
          <span className="reminders-count-active">{activeCount} active</span>
          {overdueCount > 0 && (
            <span className="reminders-count-overdue">{overdueCount} overdue</span>
          )}
          {completedCount > 0 && (
            <span className="reminders-count-completed"> · {completedCount} completed</span>
          )}
        </div>
        <div className="reminders-header-actions">
          <ShadowDOMButton
            className="reminders-add-button"
            onPress={handleAdd}
            isIconOnly
            size="md"
            color="primary"
            radius="full"
            aria-label="Add reminder"
            style={{ minWidth: '44px', minHeight: '44px' }}
          >
            <ObsidianIcon size="s" id="plus" />
          </ShadowDOMButton>
          <ShadowDOMButton
            className="reminders-toggle-completed"
            onPress={() => {
              const newValue = !showCompletedState;
              setShowCompletedState(newValue);
              // If callback provided, update the source markdown
              onToggleShowCompleted?.(newValue);
            }}
            isIconOnly
            size="md"
            variant="flat"
            radius="full"
            aria-label={showCompletedState ? "Hide completed" : "Show completed"}
            style={{ minWidth: '44px', minHeight: '44px' }}
          >
            <ObsidianIcon size="s" id={showCompletedState ? "eye-off" : "eye"} />
          </ShadowDOMButton>
        </div>
      </div>
      {reminders.length === 0 ? (
        <div className="reminders-empty">
          <ObsidianIcon size="l" id="calendar-check" />
          <p>
            No reminders
            {showToday ? " due today" : showUpcoming ? ` in the next ${effectiveDays} days` : projectFilter ? ` in project "${projectFilter}"` : ""}
          </p>
        </div>
      ) : showUpcoming && dateGroups ? (
        <LayoutGroup>
          <div className="reminders-list reminders-list-grouped">
            {dateGroups.map((group, groupIndex) => (
              <div key={group.date.toISOString()} className="reminders-date-group">
                {groupIndex > 0 && <div className="reminders-date-divider" />}
                <h3 className="reminders-date-header">{formatDateHeader(group.date)}</h3>
                <AnimatePresence mode="popLayout" initial={false}>
                  {group.reminders.map((reminder, index) => (
                    <motion.div
                      key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
                      layout="position"
                      initial={STAGGERED_CARD_ANIMATION.initial}
                      animate={STAGGERED_CARD_ANIMATION.animate(index)}
                      exit={STAGGERED_CARD_ANIMATION.exit}
                      style={{ marginBottom: '0.5rem' }}
                    >
                      <ReminderCardWrapper
                        reminder={reminder}
                        onUpdate={triggerRefresh}
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            ))}
          </div>
        </LayoutGroup>
      ) : (
        <div className="reminders-list">
          {reminders.map((reminder) => (
            <ReminderCardWrapper
              key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
              reminder={reminder}
              onUpdate={triggerRefresh}
            />
          ))}
        </div>
      )}
    </div>
  );
};
