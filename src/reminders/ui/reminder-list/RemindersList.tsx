import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { STAGGERED_CARD_ANIMATION } from "@/reminders/ui/layoutConstants";

import type { Reminder } from "@/reminders/types/plugin-reminder";
import { PluginContext } from "@/reminders/ui/reminders-context";
import { useIndexRefresh } from "@/reminders/ui/hooks/useIndexRefresh";
import { ReminderCardWrapper } from "@/reminders/components/ReminderCardWrapper";
import { ReorderableReminderList } from "@/reminders/components/ReorderableReminderList";
import { ShadowDOMButton } from "@/reminders/components/ShadowDOMButton";
import { ObsidianIcon } from "@/reminders/components/obsidian-icon";
import { openReminderCreationModal } from "@/reminders/ui/adapters/modals";
import { formatLocalDateKey } from "@/reminders/utils/reminderDate";
import {
  buildRemindersListPresentation,
  formatDateHeader,
  loadRemindersListData,
} from "./reminderListModel";
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
  const todayPrefix = formatLocalDateKey(new Date());

  // State for reminders (needed because getAll is async when showCompleted is true)
  const [rawReminders, setRawReminders] = useState<Reminder[]>([]);

  // Load reminders - always use markdown index (markdown-first mode)
  useEffect(() => {
    const loadReminders = async () => {
      const loaded = await loadRemindersListData({
        reminderIndex: plugin.reminderIndex,
        storage: plugin.storage,
        showToday,
        showUpcoming,
        showCompleted: showCompletedState,
        effectiveDays,
        todayPrefix,
      });
      setRawReminders(loaded);
    };
    void loadReminders();
  }, [plugin, showToday, showUpcoming, effectiveDays, showCompletedState, refreshToken, todayPrefix]);

  const presentation = useMemo(() => buildRemindersListPresentation({
    rawReminders,
    projectFilter,
    showToday,
    showUpcoming,
    effectiveDays,
  }), [rawReminders, projectFilter, showToday, showUpcoming, effectiveDays]);

  // Sync showCompleted prop to state when it changes (e.g., from widget update)
  useEffect(() => {
    setShowCompletedState(showCompleted);
  }, [showCompleted]);

  // Local reorder state
  const [localOrder, setLocalOrder] = useState<Reminder[]>(presentation.activeReminders);

  useEffect(() => {
    setLocalOrder(presentation.activeReminders);
  }, [presentation.activeReminders]);

  const handleReorderCommit = useCallback((orderedIds: string[]) => {
    void plugin.storage.reorder(presentation.effectiveProject, orderedIds);
  }, [plugin, presentation.effectiveProject]);

  const renderCard = useCallback((reminder: Reminder, _index: number) => (
    <ReminderCardWrapper
      key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
      reminder={reminder}
      onUpdate={triggerRefresh}
    />
  ), [triggerRefresh]);

  const handleAdd = () => {
    void openReminderCreationModal(
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
          <span className="reminders-count-active">{presentation.activeCount} active</span>
          {presentation.overdueCount > 0 && (
            <span className="reminders-count-overdue">{presentation.overdueCount} overdue</span>
          )}
          {presentation.completedCount > 0 && (
            <span className="reminders-count-completed"> · {presentation.completedCount} completed</span>
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
      {presentation.reminders.length === 0 ? (
        <div className="reminders-empty">
          <ObsidianIcon size="l" id="calendar-check" />
          <p>{presentation.emptyMessage}</p>
        </div>
      ) : showUpcoming && presentation.dateGroups ? (
        <LayoutGroup>
          <div className="reminders-list reminders-list-grouped">
            {presentation.dateGroups.map((group, groupIndex) => (
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
          {presentation.supportsReorder ? (
            <>
              <ReorderableReminderList
                reminders={localOrder}
                onReorder={setLocalOrder}
                onReorderCommit={handleReorderCommit}
                renderCard={renderCard}
              />
              {showCompletedState && presentation.reminders.filter(r => r.completed).map((reminder) => (
                <ReminderCardWrapper
                  key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
                  reminder={reminder}
                  onUpdate={triggerRefresh}
                />
              ))}
            </>
          ) : (
            presentation.reminders.map((reminder) => (
              <ReminderCardWrapper
                key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
                reminder={reminder}
                onUpdate={triggerRefresh}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};
