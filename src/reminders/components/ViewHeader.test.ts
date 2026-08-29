import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ViewHeader } from './ViewHeader';

describe('ViewHeader', () => {
  it('keeps the title and actions visible while initial metadata is hidden', () => {
    const markup = renderToStaticMarkup(React.createElement(ViewHeader, {
      title: 'Inbox',
      count: 6,
      overdueCount: 2,
      showMeta: false,
      rightContent: React.createElement('button', null, 'Refresh'),
    }));

    expect(markup).toContain('Inbox');
    expect(markup).toContain('Refresh');
    expect(markup).not.toContain('6 reminders');
    expect(markup).not.toContain('2 overdue');
  });

  it('reveals count metadata after loading completes', () => {
    const markup = renderToStaticMarkup(React.createElement(ViewHeader, {
      title: 'Inbox',
      count: 6,
      overdueCount: 2,
    }));

    expect(markup).toContain('6 reminders');
    expect(markup).toContain('2 overdue');
  });

  it('can reserve metadata space without exposing its values', () => {
    const markup = renderToStaticMarkup(React.createElement(ViewHeader, {
      title: 'Inbox',
      count: 6,
      overdueCount: 2,
      showMeta: false,
      reserveMetaSpace: true,
    }));

    expect(markup).toContain('view-header-meta is-reserved');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('6 reminders');
    expect(markup).toContain('2 overdue');
  });
});
