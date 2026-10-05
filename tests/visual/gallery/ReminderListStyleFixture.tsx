import { Fragment, useState } from 'react';
import { WebReminderCard } from '@/pwa/components/WebReminderCard';
import { usePwaPreferences } from '@/pwa/hooks/usePwaPreferences';
import { usePwaInputModality } from '@/pwa/hooks/usePwaInputModality';
import { ListStyleSetting } from '@/pwa/components/ListStyleSetting';
import { ReadingFixture } from './ReadingFixture';
import { ReorderableReminderList } from '@/reminders/components/ReorderableReminderList';
import { HighlightList } from '@/reading/ui/HighlightList';
import { BrowseView } from '@/reminders/ui/views/BrowseView';
import { TodayView } from '@/reminders/ui/views/TodayView';
import type { ReadingMetadata } from '@/reading/core/model';
import type { Reminder } from '@/reminders/types/reminder';

const sampleReminders: Reminder[] = [
  { id: '1', content: 'Review launch notes', description: 'Check the final copy before sharing.', completed: false, priority: 1, dueDate: '2026-09-04', project: 'Product launch' },
  { id: '2', content: 'Send the revised proposal', completed: false, priority: 1, dueDate: '2026-09-04', project: 'Work' },
  { id: '3', content: 'Pick up coffee beans', completed: false, priority: 4, dueDate: '2026-09-04', project: 'Personal' },
  { id: '4', content: 'A reminder with a deliberately long title and a project that must wrap without hiding its metadata', completed: false, priority: 4, dueDate: '2026-09-05', project: 'Personal/A very long project name' },
  { id: '5', content: 'Plan this afternoon', completed: false, priority: 4, dueDate: '2026-09-21', project: 'Work' },
];

const highlightedArticle: ReadingMetadata = {
  crate_reading_version: 1, crate_reading_id: '67de6c50-c70c-4c85-93f2-a048d9f33b1a',
  title: 'An essay to return to', source_url: 'https://example.com/essay', saved_at: '2026-09-21T10:00:00Z',
  reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready', capture_method: 'url',
};

export function ReminderListStyleFixture({ host }: { host: 'plugin' | 'pwa' }) {
  usePwaInputModality();
  const { preferences, updatePreferences } = usePwaPreferences();
  const [reminders, setReminders] = useState(sampleReminders);
  const [edited, setEdited] = useState('');
  const [openedProject, setOpenedProject] = useState('');
  const [committedOrder, setCommittedOrder] = useState<string[]>([]);
  const render = (reminder: Reminder, index: number) => <WebReminderCard reminder={reminder} index={index} hideProject={false}
    listStyle={preferences.reminderListStyle} onEdit={setEdited}
    onToggleComplete={id => setReminders(items => items.map(item => item.id === id ? { ...item, completed: !item.completed } : item))} />;
  return <>
    <ListStyleSetting preferences={preferences} onPreferencesChange={updatePreferences} />
    <output aria-label="Edited reminder">{edited}</output>
    <output aria-label="Opened project">{openedProject}</output>
    <output aria-label="Committed order">{committedOrder.join(',')}</output>
    <div className={`reminders-view is-primary ${host === 'pwa' ? 'pwa-reminders-view' : ''}`}>
      <TodayView reminders={reminders} renderCard={render} animationConfig={{ enabled: false }} hasFab={false} />
    </div>
    <div className="reminders-list-container" data-testid="embedded-list"><div className="reminders-list">
      {reminders.slice(0, 2).map((reminder, index) => <Fragment key={reminder.id}>{render(reminder, index)}</Fragment>)}
    </div></div>
    <div className="reminders-view is-primary" data-testid="grouped-list">
      {[[reminders[0]!], reminders.slice(1)].map((group, index) => <section key={index}>
        <h3>Group {index + 1}</h3>
        {group.map((reminder, index) => <div className="reminder-render-item" key={reminder.id}>{render(reminder, index)}</div>)}
      </section>)}
    </div>
    <div className="reminders-view is-primary" data-testid="reorderable-list">
      <ReorderableReminderList reminders={reminders} onReorder={setReminders} onReorderCommit={setCommittedOrder} renderCard={render}
        animationsEnabled={new URLSearchParams(location.search).has('motion')} />
    </div>
    <div className={`reminders-view is-primary ${host === 'pwa' ? 'pwa-reminders-view' : ''}`} data-list-style={preferences.reminderListStyle} data-testid="projects-list" style={{ height: 600 }}>
      <BrowseView projects={['Product launch', 'Personal', 'Personal/Finance', 'Personal/Health/Visits', 'Work']}
        reminders={[...reminders, { id: 'project-done', content: 'Completed launch task', completed: true, priority: 4, project: 'Product launch' }]} onProjectSelect={setOpenedProject} animationConfig={{ enabled: false }} />
    </div>
    <div style={{ height: 700 }}><ReadingFixture listStyle={preferences.reminderListStyle} onAdd={() => {}} /></div>
    <div className="crate-reading" data-list-style={preferences.reminderListStyle}>
      <HighlightList entries={[0, 1].map(index => ({ item: highlightedArticle, highlight: { text: `Saved passage ${index + 1}`, start: index * 20, end: index * 20 + 15 } }))} />
    </div>
  </>;
}
