import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BottomTabBar } from './BottomTabBar';

describe('BottomTabBar', () => {
    it('keeps icon stroke geometry stable across active states', () => {
        const markup = renderToStaticMarkup(React.createElement(BottomTabBar, {
            activeTab: 'inbox',
            onTabChange: vi.fn(),
        }));

        expect(markup).not.toContain('stroke-width="2.5"');
        expect(markup.match(/stroke-width="2"/g)).toHaveLength(4);
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
});
