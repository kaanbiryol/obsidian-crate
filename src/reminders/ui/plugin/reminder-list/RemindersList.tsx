import type React from "react";
import { useRemindersSettingsStore } from "../../../settings";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LayoutGroup } from "motion/react";
import { ReminderMotionRow } from "@/reminders/ui/shared/ReminderMotionRow";

import type { Reminder } from "@/reminders/types/reminder";
import { PluginContext } from "@/reminders/ui/plugin/reminders-context";
import { useIndexRefresh } from "@/reminders/ui/plugin/hooks/useIndexRefresh";
import { useObsidianDarkMode } from "@/reminders/ui/plugin/hooks/useObsidianDarkMode";
import { useReducedMotion } from "@/ui/shared/useReducedMotion";
import { ReminderCardWrapper } from "@/reminders/ui/plugin/ReminderCardWrapper";
import { ReminderListPresence } from "@/reminders/ui/shared/ReminderListPresence";
import { useReminderOrder } from "@/reminders/ui/shared/hooks/useReminderOrder";
import { ReorderableReminderList } from "@/reminders/ui/shared/ReorderableReminderList";
import { ShadowDOMButton } from "@/reminders/ui/plugin/ShadowDOMButton";
import { ObsidianIcon } from "@/ui/obsidian-icon";
import { ThemeIconProvider } from "@/ui/shared/ThemeIcon";
import { openReminderCreationModal } from "@/reminders/ui/plugin/reminderEditorModals";
import { persistReminderOrder } from "@/reminders/ui/plugin/persistReminderOrder";
import { requireReminderBackend } from "@/reminders/runtime";
import {
  buildRemindersListPresentation,
  loadRemindersListData,
} from "./reminderListModel";
import { formatDateHeader } from "@/reminders/ui/format/dateFormatting";
import { RemindersLoading } from "../RemindersLoading";
import "./styles.scss";
import { useReminderClock } from '../../shared/useReminderClock';
import { ReminderPageSizeContext, ReminderPagination, useReminderPagination } from '../../shared/reminder-pagination';
import { groupRemindersByDate } from "@/reminders/core/reminderSort";

type Props = {
  projectFilter?: string; // If provided, only show reminders for this project
  showCompleted?: boolean;
  showToday?: boolean; // If true, only show reminders due today
  showUpcoming?: boolean; // If true, show upcoming reminders grouped by date
  onToggleShowCompleted?: (newValue: boolean) => void; // Persist showCompleted preference
};

export const RemindersList: React.FC<Props> = props => {
  const enabled = useRemindersSettingsStore(state => state.enabled);
  return enabled
    ? <ReminderPageSizeContext.Provider value={200}><ActiveRemindersList {...props} /></ReminderPageSizeContext.Provider>
    : <p>Reminders are disabled on this device.</p>;
};

const ActiveRemindersList: React.FC<Props> = ({
  projectFilter,
  showCompleted = false,
  showToday = false,
  showUpcoming = false,
  onToggleShowCompleted,
}) => {
  const plugin = PluginContext.use();
  const isDarkMode = useObsidianDarkMode();
  const reduceMotion = useReducedMotion();
  const colorScheme = isDarkMode ? "dark" : "light";
  const effectiveDays = useRemindersSettingsStore(state => state.upcomingDaysDefault);
  const [showCompletedState, setShowCompletedState] = useState(showCompleted);

  // Subscribe to index changes for automatic refresh
  const { refreshToken, triggerRefresh } = useIndexRefresh();

  // State for reminders (needed because getAll is async when showCompleted is true)
  const [{ rawReminders, isInitialLoadComplete }, setLoadedReminders] = useState<{ rawReminders: Reminder[]; isInitialLoadComplete: boolean }>({ rawReminders: [], isInitialLoadComplete: false });
  const clock = useReminderClock(rawReminders);
  // Only Today and Upcoming queries depend on the current time.
  const loadClock = showToday || showUpcoming ? clock : null;

  // Load reminders - always use markdown index (markdown-first mode)
  useEffect(() => {
    let active = true;
    const loadReminders = async () => {
      if (!plugin.reminders) return;
      const ready = plugin.reminders.index.isInitialLoadComplete;
      const loaded = await loadRemindersListData({
        repository: plugin.reminders.repository,
        showToday,
        showUpcoming,
        showCompleted: showCompletedState,
        effectiveDays,
      });
      if (active) setLoadedReminders({ rawReminders: loaded, isInitialLoadComplete: ready });
    };
    void loadReminders();
    return () => { active = false; };
  }, [plugin, showToday, showUpcoming, effectiveDays, showCompletedState, refreshToken, loadClock]);

  const presentation = useMemo(() => buildRemindersListPresentation({
    rawReminders,
    projectFilter,
    projects: plugin.reminders?.repository.getProjects(),
    showToday,
    showUpcoming,
    effectiveDays,
    now: clock.now,
  }), [plugin, rawReminders, projectFilter, showToday, showUpcoming, effectiveDays, clock]);

  // Sync showCompleted prop to state when it changes (e.g., from widget update)
  useEffect(() => {
    setShowCompletedState(showCompleted);
  }, [showCompleted]);

  const handleReorderCommit = useCallback(async (orderedIds: string[]) => {
    await persistReminderOrder(requireReminderBackend(plugin).repository, presentation.effectiveProject, orderedIds, triggerRefresh);
    const loaded = await loadRemindersListData({
      repository: requireReminderBackend(plugin).repository,
      showToday,
      showUpcoming,
      showCompleted: showCompletedState,
      effectiveDays,
    });
    setLoadedReminders({ rawReminders: loaded, isInitialLoadComplete: requireReminderBackend(plugin).index.isInitialLoadComplete });
  }, [plugin, presentation.effectiveProject, triggerRefresh, showToday, showUpcoming, showCompletedState, effectiveDays]);
  const order = useReminderOrder(presentation.activeReminders, handleReorderCommit);
  const pagination = useReminderPagination(presentation.reminders);
  const pagedDateGroups = useMemo(() => showUpcoming ? groupRemindersByDate(pagination.items) : null, [showUpcoming, pagination.items]);
  const completedReminders = useMemo(() => presentation.reminders.filter(r => r.completed), [presentation.reminders]);
  const completedPagination = useReminderPagination(completedReminders);

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
      presentation.effectiveProject,
      () => {
        triggerRefresh();
      }
    );
  };

  if (!isInitialLoadComplete) return <RemindersLoading compact />;

  return (
    <ThemeIconProvider renderer={ObsidianIcon}>
      <div className="reminders-list-container">
      <div className="reminders-list-header">
        <div className="reminders-count">
          {showToday && <span className="reminders-count-title">Today · </span>}
          {showUpcoming && <span className="reminders-count-title">Upcoming · </span>}
          <span className="reminders-count-active">{presentation.activeCount} active</span>
          {presentation.overdueCount > 0 && (
            <>
              <span aria-hidden="true">&middot;</span>
              <span className="view-header-overdue">{presentation.overdueCount} overdue</span>
            </>
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
      ) : pagedDateGroups ? (
        <LayoutGroup>
          <ReminderPagination pagination={pagination} label="Reminders" />
          <div className="reminders-list reminders-list-grouped">
            {pagedDateGroups.map((group, groupIndex) => (
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
              {showCompletedState && <ReminderPagination pagination={completedPagination} label="Completed reminders" />}
              {showCompletedState && completedPagination.items.map((reminder) => (
                <ReminderCardWrapper
                  key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
                  reminder={reminder}
                  onUpdate={triggerRefresh}
                  colorScheme={colorScheme}
                />
              ))}
            </>
          ) : (
            <>
              <ReminderPagination pagination={pagination} label="Reminders" />
              {pagination.items.map((reminder) => (
                <ReminderCardWrapper
                  key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
                  reminder={reminder}
                  onUpdate={triggerRefresh}
                  colorScheme={colorScheme}
                />
              ))}
            </>
          )}
        </div>
      )}
      </div>
    </ThemeIconProvider>
  );
};
