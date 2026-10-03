import { IconButton } from '@/ui/shared/IconButton';
import React, { useState } from 'react';
import { PluginWorkspaceNavigation } from '@/ui/plugin/PluginWorkspaceNavigation';
import { PluginRemindersAppShell } from '@/reminders/ui/plugin/PluginRemindersAppShell';
import { DEFAULT_DOCK_TABS, type DockTab } from '@/ui/shared/navigation/dock-destinations';
import { ReminderCard } from '@/reminders/components/ReminderCard';
import type { Reminder } from '@/reminders/types/reminder';
import { ReadingFixture } from './ReadingFixture';
import { TabTransition } from '@/ui/shared/navigation/TabTransition';
import { RemindersLoading } from '@/reminders/ui/RemindersLoading';

const reminders: Reminder[] = Array.from({ length: 36 }, (_, index) => ({
  id: String(index), content: `Reminder ${index + 1}`, completed: false, priority: 4,
  project: index === 0 ? 'Inbox' : `Project ${String(index).padStart(2, '0')}`,
  dueDate: '2026-09-28',
}));
export function NavigationFixture({ isDark, onAdd }: { isDark: boolean; onAdd: (value: string) => void }) {
  const [tabs, setTabs] = useState<DockTab[]>([...DEFAULT_DOCK_TABS]);
  const [readingEnabled, setReadingEnabled] = useState(true);
  const [isInitialLoadComplete, setInitialLoadComplete] = useState(() => !new URLSearchParams(location.search).has('loading'));
  // Exercise disabling a feature without remounting the workspace.
  React.useEffect(() => {
    const disable = () => setReadingEnabled(false);
    const finishLoading = () => setInitialLoadComplete(true);
    window.addEventListener('disable-reading', disable);
    window.addEventListener('finish-reminder-loading', finishLoading);
    return () => {
      window.removeEventListener('disable-reading', disable);
      window.removeEventListener('finish-reminder-loading', finishLoading);
    };
  }, []);
  const compact = new URLSearchParams(location.search).has('compact');
  const renderShell = (props = {}) => <PluginRemindersAppShell {...props} reminders={reminders} isDarkMode={isDark} isInitialLoadComplete={isInitialLoadComplete}
    loadingContent={!isInitialLoadComplete ? <RemindersLoading /> : undefined}
    hideTabBar={compact} renderHeader={compact ? (_title, actions) => <header className="crate-modal-header">Projects{actions}</header> : undefined}
    headerRightContent={<IconButton icon="settings" size="large" iconSize="l" label="Crate settings" onClick={() => onAdd("settings")} />}
    initialTab={compact ? 'browse' : undefined} initialProject={compact ? 'Project 01' : undefined}
    upcomingDays={7} onAdd={project => onAdd(project)} onReorder={() => {}}
    renderCard={({ reminder, hideProject }) => <ReminderCard reminder={reminder} hideProject={hideProject} animationConfig={{ enabled: false }} />} />;
  if (compact) return renderShell();
  return <PluginWorkspaceNavigation tabs={tabs} onTabsChange={setTabs} remindersEnabled readingEnabled={readingEnabled}
    renderReminders={(tab, onChange, renderNavigation) => renderShell({ activeTab: tab, onTabChange: onChange, renderNavigation })}
    renderReading={renderNavigation => <ReadingFixture onAdd={() => onAdd('reading')} renderNavigation={props => renderNavigation(props)}
      renderLibraryContent={(section, content) => <TabTransition viewKey={section}>{content}</TabTransition>} />} />;
}
