import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ModalHeader } from '../shared/ModalHeader';
import { ThemeIconProvider } from '../shared/ThemeIcon';
import { ObsidianIcon } from '../obsidian-icon';

/** Shared React header for dialogs whose body uses Obsidian's DOM controls. */
export function mountModalHeader(container: HTMLElement, title: string, onClose: () => void): (() => void) & { setTitle(title: string): void } {
	const root = createRoot(container);
	const setTitle = (title: string) => flushSync(() => root.render(createElement(ThemeIconProvider, {
		renderer: ObsidianIcon,
		children: createElement(ModalHeader, { title, closeLabel: 'Close dialog', onClose }),
	})));
	setTitle(title);
	return Object.assign(() => root.unmount(), { setTitle });
}
