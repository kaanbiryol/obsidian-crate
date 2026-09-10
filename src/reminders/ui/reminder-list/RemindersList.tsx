import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LayoutGroup } from "motion/react";
import { ReminderMotionRow } from "@/reminders/components/ReminderMotionRow";

import type { Reminder } from "@/reminders/types/plugin-reminder";
import { PluginContext } from "@/reminders/ui/reminders-context";
import { useIndexRefresh } from "@/reminders/ui/hooks/useIndexRefresh";
import { useObsidianDarkMode } from "@/reminders/ui/hooks/useObsidianDarkMode";
import { useObsidianReducedMotion } from "@/reminders/ui/useObsidianReducedMotion";
import { ReminderCardWrapper } from "@/reminders/components/ReminderCardWrapper";
import { ReminderListPresence } from "@/reminders/components/ReminderListPresence";
import { useReminderOrder } from "@/reminders/ui/hooks/useReminderOrder";
import { ReorderableReminderList } from "@/reminders/components/ReorderableReminderList";
import { ShadowDOMButton } from "@/reminders/components/ShadowDOMButton";
import { ObsidianIcon } from "@/reminders/components/obsidian-icon";
import { ThemeIconProvider } from "@/reminders/components/theme-icon";
import { openReminderCreationModal } from "@/reminders/ui/adapters/modals";
import { persistReminderOrder } from "@/reminders/ui/plugin/persistReminderOrder";
import {
  buildRemindersListPresentation,
  formatDateHeader,
  loadRemindersListData,
} from "./reminderListModel";
import "./styles.scss";
import { useReminderClock } from '../useReminderClock';

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
  const isDarkMode = useObsidianDarkMode();
  const reduceMotion = useObsidianReducedMotion();
  const colorScheme = isDarkMode ? "dark" : "light";
  // Use setting default for upcoming days
  const effectiveDays = plugin.remindersSettings.upcomingDaysDefault ?? 7;
  const [showCompletedState, setShowCompletedState] = useState(showCompleted);

  // Subscribe to index changes for automatic refresh
  const { refreshToken, triggerRefresh } = useIndexRefresh();

  // State for reminders (needed because getAll is async when showCompleted is true)
  const [rawReminders, setRawReminders] = useState<Reminder[]>([]);
  const clock = useReminderClock(rawReminders);

  // Load reminders - always use markdown index (markdown-first mode)
  useEffect(() => {
    let active = true;
    const loadReminders = async () => {
      const loaded = await loadRemindersListData({
        repository: plugin.reminderRepository,
        showToday,
        showUpcoming,
        showCompleted: showCompletedState,
        effectiveDays,
      });
      if (active) setRawReminders(loaded);
    };
    void loadReminders();
    return () => { active = false; };
  }, [plugin, showToday, showUpcoming, effectiveDays, showCompletedState, refreshToken, clock]);

  const presentation = useMemo(() => buildRemindersListPresentation({
    rawReminders,
    projectFilter,
    showToday,
    showUpcoming,
    effectiveDays,
    now: clock.now,
  }), [rawReminders, projectFilter, showToday, showUpcoming, effectiveDays, clock]);

  // Sync showCompleted prop to state when it changes (e.g., from widget update)
  useEffect(() => {
    setShowCompletedState(showCompleted);
  }, [showCompleted]);

  const handleReorderCommit = useCallback(async (orderedIds: string[]) => {
    await persistReminderOrder(plugin.reminderRepository, presentation.effectiveProject, orderedIds, triggerRefresh);
    const loaded = await loadRemindersListData({
      repository: plugin.reminderRepository,
      showToday,
      showUpcoming,
      showCompleted: showCompletedState,
      effectiveDays,
    });
    setRawReminders(loaded);
  }, [plugin, presentation.effectiveProject, triggerRefresh, showToday, showUpcoming, showCompletedState, effectiveDays]);
  const order = useReminderOrder(presentation.activeReminders, handleReorderCommit);

  const renderCard = useCallback((reminder: Reminder, _index: number) => (
    <ReminderCardWrapper
      key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
      reminder={reminder}
      onUpdate={triggerRefresh}
      colorScheme={colorScheme}
    />
  ), [colorScheme, triggerRefresh]);

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
    <ThemeIconProvider renderer={ObsidianIcon}>
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
                <ReminderListPresence>
                  {group.reminders.map((reminder) => (
                    <ReminderMotionRow
                      key={reminder.id}
                      id={reminder.id}
                      section="active"
                      animationsEnabled={!reduceMotion}
                    >
                      <ReminderCardWrapper
                        reminder={reminder}
                        onUpdate={triggerRefresh}
                        colorScheme={colorScheme}
                      />
                    </ReminderMotionRow>
                  ))}
                </ReminderListPresence>
              </div>
            ))}
          </div>
        </LayoutGroup>
      ) : (
        <div className="reminders-list">
          {presentation.supportsReorder ? (
            <>
              <ReorderableReminderList
                reminders={order.displayedOrder}
                onReorder={order.onReorder}
                onReorderCommit={order.onCommit}
                onDragActiveChange={order.onDragChange}
                renderCard={renderCard}
              />
              {showCompletedState && presentation.reminders.filter(r => r.completed).map((reminder) => (
                <ReminderCardWrapper
                  key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
                  reminder={reminder}
                  onUpdate={triggerRefresh}
                  colorScheme={colorScheme}
                />
              ))}
            </>
          ) : (
            presentation.reminders.map((reminder) => (
              <ReminderCardWrapper
                key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
                reminder={reminder}
                onUpdate={triggerRefresh}
                colorScheme={colorScheme}
              />
            ))
          )}
        </div>
      )}
      </div>
    </ThemeIconProvider>
  );
};
