import { useState } from 'react';
import { WebReminderCard } from '@/pwa/components/WebReminderCard';
import { usePwaPreferences } from '@/pwa/hooks/usePwaPreferences';
import { usePwaInputModality } from '@/pwa/hooks/usePwaInputModality';
import { ReminderSettings } from '@/pwa/components/ReminderSettings';
import type { Reminder } from '@/reminders/types/reminder';

const sampleReminders: Reminder[] = [
  { id: '1', content: 'Review launch notes', description: 'Check the final copy before sharing.', completed: false, priority: 1, dueDate: '2026-09-04', project: 'Product launch' },
  { id: '2', content: 'Send the revised proposal', completed: false, priority: 1, dueDate: '2026-09-04', project: 'Work' },
  { id: '3', content: 'Pick up coffee beans', completed: false, priority: 4, dueDate: '2026-09-04', project: 'Personal' },
  { id: '4', content: 'A reminder with a deliberately long title and a project that must wrap without hiding its metadata', completed: false, priority: 4, dueDate: '2026-09-05', project: 'Personal/A very long project name' },
];

export function ReminderListStyleFixture({ host }: { host: 'plugin' | 'pwa' }) {
  usePwaInputModality();
  const { preferences, updatePreferences } = usePwaPreferences();
  const [reminders, setReminders] = useState(sampleReminders);
  const [edited, setEdited] = useState('');
  const render = (reminder: Reminder, index: number) => <WebReminderCard reminder={reminder} index={index} hideProject={false}
    listStyle={preferences.reminderListStyle} onEdit={setEdited}
    onToggleComplete={id => setReminders(items => items.map(item => item.id === id ? { ...item, completed: !item.completed } : item))} />;
  return <>
    <ReminderSettings model={null} homeScreenPlatform={null} preferences={preferences} onPreferencesChange={updatePreferences} />
    <output aria-label="Edited reminder">{edited}</output>
    <div className={`reminders-view is-primary ${host === 'pwa' ? 'pwa-reminders-view' : ''}`}>
      <div className="reminders-view-scroll">
        {reminders.map((reminder, index) => <div className="reminder-render-item" key={reminder.id}>{render(reminder, index)}</div>)}
      </div>
    </div>
    <div className="reminders-list-container" data-testid="embedded-list"><div className="reminders-list">
      {reminders.slice(0, 2).map((reminder, index) => <div key={reminder.id}>{render(reminder, index)}</div>)}
    </div></div>
  </>;
}
