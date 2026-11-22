import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ModalHeader } from '../shared/ModalHeader';
import { ThemeIconProvider } from '../shared/ThemeIcon';
import { ObsidianIcon } from '../obsidian-icon';

/** A header's title, plus a back button in place of Close and a right-side action when set. */
export interface ModalHeaderState {
	title: string;
	back?: { label: string; run: () => void };
	action?: { label: string; onClick: () => void };
}

/** Shared React header for dialogs whose body uses Obsidian's DOM controls. */
export function mountModalHeader(container: HTMLElement, title: string, onClose: () => void): (() => void) & { setTitle(title: string): void; render(state: ModalHeaderState): void } {
	const root = createRoot(container);
	const render = ({ title, back, action }: ModalHeaderState) => flushSync(() => root.render(createElement(ThemeIconProvider, {
		renderer: ObsidianIcon,
		children: createElement(ModalHeader, back
			? { title, closeLabel: back.label, navigation: 'back', onClose: back.run, action }
			: { title, closeLabel: 'Close dialog', onClose, action }),
	})));
	render({ title });
	return Object.assign(() => root.unmount(), { setTitle: (title: string) => render({ title }), render });
}
