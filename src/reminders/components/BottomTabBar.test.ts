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
});
