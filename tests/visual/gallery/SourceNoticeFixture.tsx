import React, { useEffect, useRef, useState } from 'react';
import { PluginReminderSourceNotice } from '@/reminders/ui/plugin/PluginReminderSourceNotice';
import { PluginRemindersAppShell } from '@/reminders/ui/plugin/PluginRemindersAppShell';
import { ReminderCard } from '@/reminders/components/ReminderCard';
import { IconButton } from '@/ui/shared/IconButton';
import type { Reminder } from '@/reminders/types/reminder';

const reminders: Reminder[] = [
  'Find a new hiking route', 'Try the new coffee place', 'Find a frame for the Lisbon print',
].map((content, index) => ({ id: String(index), content, completed: false, project: 'Inbox', priority: 4 }));

export function SourceNoticeFixture({ isDark }: { isDark: boolean }) {
  const many = new URLSearchParams(location.search).has('many');
  const duplicateNames = new URLSearchParams(location.search).has('duplicates');
  const initialIssues = useRef(duplicateNames ? ['Reminders/Work/Inbox.md', 'Reminders/Personal/Inbox.md'].map(path => ({
    path, reason: 'Invalid reminder description block on line 8',
  })) : many ? Array.from({ length: 21 }, (_, i) => ({
    path: i === 0 ? 'Reminders/<img src=x onerror=alert(1)>.md' : `Reminders/A long project name/Unreadable note ${i}.md`,
    reason: 'Save this note as UTF-8 without null characters before editing its reminders. The original vault file remains synced.',
  })) : [{ path: 'Reminders/Inbox.md', reason: 'Invalid reminder description block on line 8.' }]);
  const [issues, setIssues] = useState(initialIssues.current);
  const [openedNote, setOpenedNote] = useState('');
  const attempts = useRef(0);
  useEffect(() => {
    const recover = () => setIssues([]);
    const fail = () => setIssues(initialIssues.current);
    window.addEventListener('crate-test-source-recovered', recover);
    window.addEventListener('crate-test-source-failed', fail);
    return () => {
      window.removeEventListener('crate-test-source-recovered', recover);
      window.removeEventListener('crate-test-source-failed', fail);
    };
  }, []);
  const notice = <PluginReminderSourceNotice issues={issues} onOpenNote={async path => {
    if (new URLSearchParams(location.search).has('openError')) throw new Error('This note is no longer available. Retry the scan to update the list.');
    setOpenedNote(path);
  }} onRefresh={async () => {
    attempts.current++;
    await new Promise<void>(resolve => window.addEventListener('crate-test-refresh', () => resolve(), { once: true }));
    if (attempts.current === 1) throw new Error('Storage is temporarily unavailable. Try again.');
    setIssues([]);
  }} />;
  return <PluginRemindersAppShell reminders={reminders} isDarkMode={isDark} isInitialLoadComplete
    headerRightContent={<IconButton icon="settings" label="Crate settings" onClick={() => {}} />}
    upcomingDays={7} onAdd={() => {}} onReorder={() => {}} belowHeaderContent={notice}
    renderCard={({ reminder }) => <ReminderCard reminder={reminder} colorScheme={isDark ? 'dark' : 'light'} animationConfig={{ enabled: false }} />}>
    {openedNote && <output data-testid="opened-note">{openedNote}</output>}
  </PluginRemindersAppShell>;
}
