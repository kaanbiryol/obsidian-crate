import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FeatureNavigationContext, type CrateSection } from './components/FeatureSwitcherButton';
import { ThemeIconProvider } from '@/reminders/components/theme-icon';
import { PwaThemeIcon } from './components/PwaThemeIcon';
import { usePwaInputModality } from './hooks/usePwaInputModality';

const Reading = lazy(() => import('./reading/App'));
const currentSection = (): CrateSection => new URL(location.href).searchParams.get('section') === 'reading' ? 'reading' : 'reminders';

export function FeatureShell({ reminders }: { reminders: React.ReactNode }) {
	usePwaInputModality();
	const [section, setSection] = useState(currentSection);
	const [visited, setVisited] = useState(() => new Set([section]));
	const root = useRef<HTMLDivElement>(null), restoreFocus = useRef(false);
	const locations = useRef<Record<CrateSection, { url: string; state: unknown }>>({
		reading: { url: '/notifications?section=reading', state: null }, reminders: { url: '/notifications', state: null },
	});
	useEffect(() => {
		const navigate = () => { const next = currentSection(); setVisited(current => new Set([...current, next])); setSection(next); };
		window.addEventListener('popstate', navigate); return () => window.removeEventListener('popstate', navigate);
	}, []);
	useEffect(() => {
		if (!restoreFocus.current || !root.current) return;
		const focus = () => {
			const button = root.current?.querySelector<HTMLElement>(`[data-crate-section="${section}"] .pwa-feature-switch-button`);
			if (!button) return false;
			restoreFocus.current = false; button.focus({ preventScroll: true }); return true;
		};
		if (focus()) return;
		// The first visit can still be loading its app or connection screen.
		const observer = new MutationObserver(() => { if (focus()) observer.disconnect(); });
		observer.observe(root.current, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [section]);
	const toggle = useCallback(() => {
		const next = section === 'reading' ? 'reminders' : 'reading';
		locations.current[section] = { url: location.pathname + location.search, state: history.state };
		history.replaceState(locations.current[next].state, '', locations.current[next].url);
		restoreFocus.current = true;
		setVisited(current => new Set([...current, next])); setSection(next);
	}, [section]);
	const navigation = useMemo(() => ({ section, toggle }), [section, toggle]);
	return <ThemeIconProvider renderer={PwaThemeIcon}><FeatureNavigationContext.Provider value={navigation}><div ref={root} className="crate-feature-shell">
		{visited.has('reading') && <div className="crate-feature-panel crate-reminders-ui pwa-reading-root" data-crate-section="reading" hidden={section !== 'reading'}><Suspense fallback={<p role="status">Opening Reading…</p>}><Reading /></Suspense></div>}
		{visited.has('reminders') && <div className="crate-feature-panel crate-reminders-ui" data-crate-section="reminders" hidden={section !== 'reminders'}>{reminders}</div>}
	</div></FeatureNavigationContext.Provider></ThemeIconProvider>;
}
