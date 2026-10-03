import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';

vi.mock('./ReadingDialog', () => ({ PluginReadingDialog: ({ children }: { children: React.ReactNode }) => React.createElement('div', { role: 'dialog' }, children) }));
import { ObsidianReadingDialog } from './ObsidianReadingDialog';

it('portals to the owning pane outside its tab layer and removes the overlay on unmount', () => {
	renderHook(() => null);
	const pane = document.createElement('div');
	pane.className = 'plugin-workspace-navigation';
	const tab = document.createElement('div');
	tab.className = 'pwa-tab-panel';
	pane.append(tab); document.body.append(pane);
	const root = createRoot(tab);
	const onClose = vi.fn();
	try {
		act(() => root.render(React.createElement(ObsidianReadingDialog, { title: 'Filter by article', onClose, children: 'First option' })));
		expect(tab.querySelector('[role="dialog"]')).toBeNull();
		expect(pane.querySelector('.crate-reading-pane-overlay')?.parentElement).toBe(pane);
		expect(pane.querySelector('[role="dialog"]')?.textContent).toBe('First option');
		act(() => root.render(React.createElement(ObsidianReadingDialog, { title: 'Filter by article', onClose, children: 'Updated option' })));
		expect(pane.querySelector('[role="dialog"]')?.textContent).toBe('Updated option');
		expect(pane.querySelectorAll('.crate-reading-pane-overlay')).toHaveLength(1);
	} finally { act(() => root.unmount()); pane.remove(); }
	expect(document.querySelector('.crate-reading-pane-overlay')).toBeNull();
	expect(onClose).not.toHaveBeenCalled();
});
