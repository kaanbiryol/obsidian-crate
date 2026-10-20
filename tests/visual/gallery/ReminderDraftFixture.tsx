import { useState } from 'react';
import type { Reminder } from '@/reminders/types';
import { useReminderDraft } from '@/reminders/ui/plugin/reminder-modal/useReminderDraft';

const projects = ['Inbox', 'Work'];
const recurring: Reminder = {
  id: 'draft-recurrence', content: 'Call Alex', completed: false, project: 'Inbox', priority: 4,
  dueDatetime: '2026-10-05T13:00:37.123Z',
  recurrence: { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0,
    timezone: 'America/New_York', count: 8, completedCount: 3, endDate: '2027-12-31' },
};

/** Exercise the plugin hook's real effect lifecycle without duplicating its draft policy. */
export function ReminderDraftFixture() {
  const [renders, setRenders] = useState(0);
  const mode = new URLSearchParams(location.search).get('draft');
  const draft = useReminderDraft({
    reminder: mode === 'recurring' ? recurring : undefined,
    initialDueDate: mode === 'implicit' ? '2026-10-08' : undefined,
    projects, defaultProject: 'Inbox',
  });
  return <>
    <label>Draft content<textarea value={draft.content} onChange={event => draft.setContent(event.target.value)} /></label>
    <button onClick={() => draft.applyDateSelection('2026-10-12', false)}>Choose date</button>
    <button onClick={() => draft.applyDateSelection(null)}>Remove date</button>
    <button onClick={() => draft.applyRecurrenceSelection({ frequency: 'daily', interval: 2, hour: 8, minute: 15, timezone: 'UTC' })}>Choose recurrence</button>
    <button onClick={() => draft.applyRecurrenceSelection(null)}>Remove recurrence</button>
    <button onClick={() => setRenders(value => value + 1)}>Rerender draft</button>
    <output data-testid="draft-renders">{renders}</output>
    <pre data-testid="draft-state">{JSON.stringify({ content: draft.content, dueDate: draft.dueDate,
      hasTime: draft.hasTime, recurrence: draft.recurrence ?? null, project: draft.project, priority: draft.priority })}</pre>
  </>;
}
