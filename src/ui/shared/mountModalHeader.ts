import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ModalHeader } from './ModalHeader';
import { ThemeIconProvider } from '../../reminders/components/theme-icon';
import { ObsidianIcon } from '../../reminders/components/obsidian-icon';

/** Shared React header for dialogs whose body uses Obsidian's DOM controls. */
export function mountModalHeader(container: HTMLElement, title: string, onClose: () => void): () => void {
	const root = createRoot(container);
	flushSync(() => root.render(createElement(ThemeIconProvider, {
		renderer: ObsidianIcon,
		children: createElement(ModalHeader, { title, closeLabel: 'Close dialog', onClose }),
	})));
	return () => root.unmount();
}
