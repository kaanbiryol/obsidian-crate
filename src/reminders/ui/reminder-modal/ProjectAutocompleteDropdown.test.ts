import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { getProjectColor } from '../../utils/projectColors';
import { ProjectAutocompleteDropdown } from './ProjectAutocompleteDropdown';

function render(isDark: boolean): string {
    const rect = { top: 0, bottom: 400, left: 0, right: 400, width: 400, height: 400 } as DOMRect;
    const container = {
        getBoundingClientRect: () => rect,
        closest: () => ({ getBoundingClientRect: () => rect }),
    } as unknown as HTMLElement;
    return renderToStaticMarkup(React.createElement(ProjectAutocompleteDropdown, {
        filteredProjects: ['Work'],
        highlightedIndex: 0,
        anchorRect: { ...rect, top: 20, bottom: 40 },
        containerRef: { current: container },
        isDark,
        onSelect: vi.fn(),
    }));
}

describe('ProjectAutocompleteDropdown', () => {
    // The PWA has no Obsidian body theme classes, so the host must supply its scheme.
    it.each([true, false])('uses the host color scheme for project dots (dark: %s)', (isDark) => {
        const accent = getProjectColor('Work')[isDark ? 'dark' : 'light'].accent;

        expect(render(isDark)).toContain(`--project-picker-dot-accent:${accent}`);
    });
});
