import { useEffect, useId, useRef, useState } from 'react';
import type React from 'react';
import { Button } from '../../ui/shared/Button';
import { ThemeIcon } from '../../ui/shared/ThemeIcon';

export interface ReaderMenuAction {
	label: string;
	icon: string;
	onSelect: () => void;
	disabled?: boolean;
	tone?: 'danger';
}

/**
 * Secondary reader actions behind one top-bar button, like an iOS overflow menu.
 * Hand-rolled because Base UI's Menu would add its positioning engine to both bundles.
 */
export function ReaderMoreMenu({ label, actions, disabled = false }: { label: string; actions: ReaderMenuAction[]; disabled?: boolean }) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLSpanElement>(null), trigger = useRef<HTMLButtonElement>(null);
	const menuId = useId();
	const items = () => [...root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []];
	const close = (refocus: boolean) => { setOpen(false); if (refocus) trigger.current?.focus({ preventScroll: true }); };
	useEffect(() => {
		if (!open || !root.current) return;
		const menu = root.current;
		items()[0]?.focus({ preventScroll: true });
		// composedPath sees through the plugin's Shadow DOM.
		const outside = (event: PointerEvent) => { if (!event.composedPath().includes(menu)) setOpen(false); };
		menu.ownerDocument.addEventListener('pointerdown', outside, true);
		return () => menu.ownerDocument.removeEventListener('pointerdown', outside, true);
	}, [open]);
	if (!actions.length) return null;
	const onKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
		if (event.key === 'Tab') { setOpen(false); return; }
		const list = items(), index = list.indexOf(event.target as HTMLButtonElement);
		const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: list.length - 1 }[event.key];
		if (next === undefined || !list.length) return;
		event.preventDefault();
		list[(next + list.length) % list.length]?.focus();
	};
	const regular = actions.filter(action => action.tone !== 'danger'), danger = actions.filter(action => action.tone === 'danger');
	const item = (action: ReaderMenuAction) => <button key={action.label} type="button" role="menuitem" className="crate-reading-menu__item"
		data-tone={action.tone} disabled={action.disabled} onClick={() => { close(true); action.onSelect(); }}>
		<span>{action.label}</span><ThemeIcon id={action.icon} size="m" aria-hidden="true" />
	</button>;
	return <span ref={root} className="crate-reading-menu">
		<Button ref={trigger} className="crate-icon-button" data-size="large" data-tone="neutral" data-variant="ghost" aria-label={label} title={label}
			aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled} onClick={() => setOpen(value => !value)}>
			<ThemeIcon id="more-horizontal" size="m" aria-hidden="true" />
		</Button>
		{open && <div id={menuId} role="menu" aria-label={label} className="crate-reading-menu__popup" onKeyDown={onKeyDown}>
			{regular.map(item)}
			{regular.length > 0 && danger.length > 0 && <div role="separator" className="crate-reading-menu__separator" />}
			{danger.map(item)}
		</div>}
	</span>;
}
