import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BottomTabBar } from './BottomTabBar';

describe('BottomTabBar', () => {
    it('delegates every tab icon to Obsidian at the themed large size', () => {
        const markup = renderToStaticMarkup(React.createElement(BottomTabBar, {
            activeTab: 'inbox',
            onTabChange: vi.fn(),
        }));

        expect(markup.match(/data-icon-size="l"/g)).toHaveLength(4);
        expect(markup).toContain('data-icon="inbox"');
        expect(markup).toContain('data-icon="calendar"');
        expect(markup).toContain('data-icon="calendar-range"');
        expect(markup).toContain('data-icon="folder-open"');
    });

    it('renders one persistent slider outside the tab buttons', () => {
        const markup = renderToStaticMarkup(React.createElement(BottomTabBar, {
            activeTab: 'today',
            onTabChange: vi.fn(),
        }));

        expect(markup.match(/bottom-tab-slider-track/g)).toHaveLength(1);
        expect(markup.match(/bottom-tab-slider"/g)).toHaveLength(1);
        expect(markup).toContain('grid-column:2');
    });

    it('can render a static active indicator', () => {
        const markup = renderToStaticMarkup(React.createElement(BottomTabBar, {
            activeTab: 'upcoming',
            onTabChange: vi.fn(),
            animateActiveIndicator: false,
        }));

        expect(markup.match(/bottom-tab-slider"/g)).toHaveLength(1);
        expect(markup).toContain('grid-column:3');
        expect(markup).not.toContain('data-framer');
    });

    it('identifies the reminder navigation and its current view', () => {
        const markup = renderToStaticMarkup(React.createElement(BottomTabBar, {
            activeTab: 'upcoming',
            onTabChange: vi.fn(),
        }));

        expect(markup).toContain('<nav class="bottom-tab-bar is-bottom " aria-label="Reminder views">');
        expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
        expect(markup).toContain('data-tab="upcoming" aria-current="page"');
    });
});
