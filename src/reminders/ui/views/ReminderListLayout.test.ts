import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Reminder } from '../../types/reminder';
import { InboxView } from './InboxView';
import { TodayView } from './TodayView';
import { UpcomingView } from './UpcomingView';
import { ProjectDetailView } from './ProjectDetailView';

const reminder: Reminder = {
  id: 'active', content: 'Active task', priority: 4, completed: false,
  project: 'Inbox', dueDate: '2000-01-01',
};
const completed: Reminder = { ...reminder, id: 'done', content: 'Finished task', completed: true };
const renderCard = (item: Reminder) => React.createElement('span', null, item.content);
const common = { renderCard, animationConfig: { enabled: false } };

function scrollClass(markup: string) {
  return markup.match(/class="([^"]*reminders-view-scroll[^"]*)"/)?.[1];
}

describe('shared reminder screen layout', () => {
  it('uses the same scrolling and FAB clearance across all four screens', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const upcoming = { ...reminder, dueDatetime: tomorrow.toISOString(), dueDate: undefined };
    const screens = [
      React.createElement(InboxView, { ...common, reminders: [reminder], }),
      React.createElement(TodayView, { ...common, reminders: [reminder], }),
      React.createElement(UpcomingView, { ...common, reminders: [upcoming], }),
      React.createElement(ProjectDetailView, { ...common, project: "Inbox", onBack: () => {}, reminders: [reminder], }),
    ];
    const classes = screens.map(screen => scrollClass(renderToStaticMarkup(screen)));
    expect(classes[0]).toContain('has-fab');
    expect(new Set(classes).size).toBe(1);
  });

  it('retains completed-only project and inbox lists and the project header', () => {
    for (const screen of [
      React.createElement(InboxView, { ...common, reminders: [completed], hasFab: false, }),
      React.createElement(ProjectDetailView, { ...common, reminders: [completed], project: "Inbox", onBack: () => {}, hasFab: false, }),
    ]) {
      const markup = renderToStaticMarkup(screen);
      expect(markup).toContain('Completed (1)');
      expect(markup).toContain('aria-expanded="false"');
      expect(scrollClass(markup)).not.toContain('has-fab');
      expect(markup).not.toContain('Finished task');
    }
    const empty = renderToStaticMarkup(React.createElement(ProjectDetailView, { ...common, reminders: [], project: "Work", onBack: () => {}, }));
    expect(empty).toContain('Projects');
    expect(empty).toContain('Work');
    expect(empty).toContain('No reminders');
    expect(scrollClass(empty)).toBeUndefined();
  });
});
