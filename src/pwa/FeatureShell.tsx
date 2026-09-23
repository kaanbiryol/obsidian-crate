import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { FeatureNavigationContext, type CrateSection } from './components/FeatureSwitcherButton';
import { ThemeIconProvider } from '@/reminders/components/theme-icon';
import { PwaThemeIcon } from './components/PwaThemeIcon';
import { usePwaInputModality } from './hooks/usePwaInputModality';
import { ReadingOpening } from './reading/ReadingOpening';

const Reading = lazy(() => import('./reading/App'));
const currentSection = (): CrateSection => new URL(location.href).searchParams.get('section') === 'reading' ? 'reading' : 'reminders';
const MODE_TRANSITION_MS = 200;

export function FeatureShell({ reminders }: { reminders: React.ReactNode }) {
	usePwaInputModality();
	const [section, setSection] = useState(currentSection);
	const [leavingSection, setLeavingSection] = useState<CrateSection | null>(null);
	const [visited, setVisited] = useState(() => new Set([section]));
	const root = useRef<HTMLDivElement>(null), restoreFocus = useRef(false);
	const sectionRef = useRef(section);
	const locations = useRef<Record<CrateSection, { url: string; state: unknown }>>({
		reading: { url: '/notifications?section=reading', state: null }, reminders: { url: '/notifications', state: null },
	});
	const showSection = useCallback((next: CrateSection) => {
		const previous = sectionRef.current;
		if (next === previous) return;
		sectionRef.current = next;
		setLeavingSection(previous);
		setVisited(current => new Set([...current, next]));
		setSection(next);
	}, []);
	useEffect(() => {
		const navigate = () => showSection(currentSection());
		window.addEventListener('popstate', navigate); return () => window.removeEventListener('popstate', navigate);
	}, [showSection]);
	useEffect(() => {
		if (!leavingSection) return;
		const timeout = window.setTimeout(() => setLeavingSection(null), MODE_TRANSITION_MS);
		return () => window.clearTimeout(timeout);
	}, [leavingSection, section]);
	useEffect(() => {
		if (!restoreFocus.current || !root.current) return;
		let frame = 0;
		let attempts = 0;
		let focusedButton: HTMLElement | null = null;
		const focus = () => {
			const button = root.current?.querySelector<HTMLElement>(`[data-crate-section="${section}"] .pwa-feature-switch-button`);
			if (!button) return false;
			if (!restoreFocus.current && (focusedButton?.isConnected || document.activeElement !== document.body)) return true;
			button.focus({ preventScroll: true });
			if (document.activeElement !== button) return false;
			restoreFocus.current = false;
			focusedButton = button;
			return true;
		};
		const retry = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				if (focus()) attempts = 0;
				else if (attempts++ < 8 && root.current?.querySelector(`[data-crate-section="${section}"] .pwa-feature-switch-button`)) retry();
			});
		};
		// A newly opened panel becomes visible on the next frame. Its app may
		// also replace its first button while loading, so follow that replacement.
		const observer = new MutationObserver(() => {
			if (restoreFocus.current || (focusedButton && !focusedButton.isConnected && document.activeElement === document.body)) {
				attempts = 0;
				retry();
			}
		});
		observer.observe(root.current, { childList: true, subtree: true });
		retry();
		return () => { observer.disconnect(); cancelAnimationFrame(frame); };
	}, [section]);
	const toggle = () => {
		const previous = sectionRef.current;
		const next = previous === 'reading' ? 'reminders' : 'reading';
		locations.current[previous] = { url: location.pathname + location.search, state: history.state };
		history.replaceState(locations.current[next].state, '', locations.current[next].url);
		restoreFocus.current = true;
		showSection(next);
	};
	return <ThemeIconProvider renderer={PwaThemeIcon}><div ref={root} className="crate-feature-shell">
		<div className="crate-feature-panel crate-reminders-ui pwa-reading-root" data-crate-section="reading" data-active={section === 'reading'} data-leaving={leavingSection === 'reading'} data-entering={section === 'reading' && leavingSection !== null} inert={section !== 'reading'} aria-hidden={section !== 'reading'}><FeatureNavigationContext.Provider value={{ section: 'reading', toggle }}>{visited.has('reading') && <Suspense fallback={<ReadingOpening />}><Reading /></Suspense>}</FeatureNavigationContext.Provider></div>
		<div className="crate-feature-panel crate-reminders-ui" data-crate-section="reminders" data-active={section === 'reminders'} data-leaving={leavingSection === 'reminders'} data-entering={section === 'reminders' && leavingSection !== null} inert={section !== 'reminders'} aria-hidden={section !== 'reminders'}><FeatureNavigationContext.Provider value={{ section: 'reminders', toggle }}>{visited.has('reminders') && reminders}</FeatureNavigationContext.Provider></div>
	</div></ThemeIconProvider>;
}
