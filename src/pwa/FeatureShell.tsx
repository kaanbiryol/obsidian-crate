import { AppConnectionGate } from './connection/AppConnectionGate';
import { PwaSyncProvider } from './sync/PwaSyncProvider';
import { SharedFeaturesContext, useServerFeatures } from './shared-features';
import { Button } from '@/ui/shared/Button';
import { createPushedScreenHistory } from './pushed-screen-history';
import { cancelDetailHistoryOpen, installDetailHistory } from './detail-history';
import { PwaUpdateProvider } from './components/PwaUpdateProvider';
import { dockDestinationIndex } from './dock-preferences';
import { usePwaPreferences } from './hooks/usePwaPreferences';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FeatureNavigationContext, type CrateSection, type DockDestination } from './components/FeatureSwitcherButton';
import { ThemeIconProvider } from '@/ui/shared/ThemeIcon';
import type { ReadingSection } from '@/reading/ui/reading-presentation';
import { PwaThemeProvider } from './components/PwaThemeProvider';
import { PwaThemeIcon } from './components/PwaThemeIcon';
import { usePwaInputModality } from './hooks/usePwaInputModality';
import { ReadingFeature } from './reading/ReadingFeature';
import { usePwaBackGesture } from './hooks/usePwaBackGesture';
import { loadPwaPreferences } from './preferences';
import { resolvePwaOpeningDestination } from './opening-destination';
import { createSettingsStore } from './settings-store';
import { SettingsContext, useSettingsOpen, useSettingsStore } from './settings-context';
import { SettingsSheet } from './components/SettingsSheet';
import { DockMorphContext, useDockMorphState } from '@/ui/shared/navigation/useDockMorph';

const currentSection = (): CrateSection => new URL(location.href).searchParams.get('section') === 'reading' ? 'reading' : 'reminders';
const MODE_TRANSITION_FALLBACK_MS = 1_000;

export function FeatureShell({ reminders }: { reminders: React.ReactNode }) {
	const [settings] = useState(() => createSettingsStore(new URL(location.href).searchParams.get('setup') === 'shortcut'));
	return <PwaThemeProvider><SettingsContext.Provider value={settings}><FeatureShellContent reminders={reminders} /></SettingsContext.Provider></PwaThemeProvider>;
}

function FeatureShellContent({ reminders }: { reminders: React.ReactNode }) {
	const features = useServerFeatures();
	const dockMorph = useDockMorphState();
	useLayoutEffect(installDetailHistory, []);
	usePwaInputModality();
	const [launch] = useState(() => resolvePwaOpeningDestination(location.search, loadPwaPreferences().defaultScreen));
	const [section, setSection] = useState<CrateSection>(() => launch.tab === 'reading' ? 'reading' : 'reminders');
	const [destination, setDestination] = useState<DockDestination | null>(() => launch.tab === 'reading' ? { section: 'reading', tab: launch.readingTab } : null);
	const [settingsOpen] = useSettingsOpen();
	const settings = useSettingsStore();
	const [settingsNavigation] = useState(() => createPushedScreenHistory(['shortcut', 'logout', 'install'] as const));
	useEffect(() => { if (!settingsOpen) settingsNavigation.reset(); }, [settingsOpen, settingsNavigation]);
	const [shortcutLaunch] = useState(() => new URL(location.href).searchParams.get('setup') === 'shortcut');
	const openedShortcut = useRef(false);
	const [reminderDockIndex, rememberReminderDockIndex] = useState<number | null>(null);
	const { preferences } = usePwaPreferences();
	const [readingTab, rememberReadingTab] = useState<ReadingSection>(() => launch.tab === 'reading' ? launch.readingTab : 'inbox');
	const dockIndex = section === 'reading' ? dockDestinationIndex(preferences.dockTabs, 'reading', readingTab) : reminderDockIndex;
	const [leavingSection, setLeavingSection] = useState<CrateSection | null>(null);
	// Keep the painted front layer in place through reversals. Swapping the
	// layers mid-fade would replace the current mixture with an opaque screen.
	const [frontSection, setFrontSection] = useState(section);
	const [visited, setVisited] = useState(() => new Set([section]));
	const settingsOpened = useCallback(() => {
		if (shortcutLaunch && !openedShortcut.current) {
			openedShortcut.current = true;
			const url = new URL(location.href); url.searchParams.delete('setup');
			history.replaceState(history.state, '', url);
			settingsNavigation.push('shortcut');
		}
	}, [settingsNavigation, shortcutLaunch]);
	useEffect(() => {
		// Keep launch preference resolution consistent with feature history and links.
		if (launch.tab === 'reading' && currentSection() !== 'reading') {
			const url = new URL(location.href); url.searchParams.set('section', 'reading');
			history.replaceState(history.state, '', url);
		}
	}, [launch]);
	const root = useRef<HTMLDivElement>(null), restoreFocus = useRef(false);
	usePwaBackGesture(root);
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
	useLayoutEffect(() => settingsNavigation.install(() => {
		showSection(currentSection());
		settings.setOpen(true);
	}), [settings, settingsNavigation, showSection]);
	useEffect(() => {
		const navigate = () => { settings.setOpen(false); showSection(currentSection()); };
		window.addEventListener('popstate', navigate); return () => window.removeEventListener('popstate', navigate);
	}, [showSection, settings]);
	const finishSectionTransition = useCallback(() => {
		setFrontSection(section);
		setLeavingSection(null);
	}, [section]);
	const finishSettledSection = useCallback(() => {
		const front = root.current?.querySelector<HTMLElement>(`[data-crate-section="${frontSection}"]`);
		if (front && Number(getComputedStyle(front).opacity) === (section === frontSection ? 1 : 0)) finishSectionTransition();
	}, [frontSection, section, finishSectionTransition]);
	useLayoutEffect(() => {
		if (!leavingSection) return;
		// Also settle reduced motion and reversals before a transition starts.
		const frame = requestAnimationFrame(finishSettledSection);
		const timeout = window.setTimeout(finishSectionTransition, MODE_TRANSITION_FALLBACK_MS);
		return () => { cancelAnimationFrame(frame); window.clearTimeout(timeout); };
	}, [leavingSection, finishSectionTransition, finishSettledSection]);
	useEffect(() => {
		if (!restoreFocus.current || !root.current) return;
		let frame = 0;
		let attempts = 0;
		let focusedButton: HTMLElement | null = null;
		const focus = () => {
			const panel = root.current?.querySelector(`[data-crate-section="${section}"]`);
			const button = Array.from(panel?.querySelectorAll<HTMLElement>('[data-dock-active="true"], .pwa-feature-switch-button') ?? []).find(candidate => candidate.getClientRects().length > 0);
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
				else if (attempts++ < 8 && root.current?.querySelector(`[data-crate-section="${section}"] [data-dock-switcher="true"], [data-crate-section="${section}"] .pwa-feature-switch-button`)) retry();
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
	const switchSection = (next: CrateSection) => {
		if (!features[next]) return;
		const previous = sectionRef.current;
		if (next === previous) return;
		locations.current[previous] = { url: location.pathname + location.search, state: history.state };
		history.replaceState(locations.current[next].state, '', locations.current[next].url);
		cancelDetailHistoryOpen();
		restoreFocus.current = true;
		showSection(next);
	};
	const navigate = (next: DockDestination) => {
		// The loading header, dock and first library render share this selection.
		// Set it before entering, rather than waiting for the loaded dock's effect.
		if (next.section === 'reading') rememberReadingTab(next.tab);
		setDestination(next);
		switchSection(next.section);
	};
	const toggle = () => { switchSection(sectionRef.current === 'reading' ? 'reminders' : 'reading'); };
	const panelStyle = (panel: CrateSection) => ({
		zIndex: panel === frontSection ? 2 : 1,
		opacity: panel === frontSection ? Number(section === frontSection) : Number(leavingSection !== null),
	});
	const paused = (feature: CrateSection) => <div className="crate-reading__empty pwa-feature-paused" role="status">
		<h2>{feature === 'reading' ? 'Reading' : 'Reminders'} paused</h2>
		<Button onClick={() => settings.openSync()}>Sync and settings</Button>
		<p>Enable it in Crate settings in Obsidian. Your notes and setup are preserved.</p>
		{features[feature === 'reading' ? 'reminders' : 'reading'] && <Button onClick={() => switchSection(feature === 'reading' ? 'reminders' : 'reading')}>Open {feature === 'reading' ? 'Reminders' : 'Reading'}</Button>}
	</div>;
	return <DockMorphContext.Provider value={dockMorph}><SharedFeaturesContext.Provider value={features}><ThemeIconProvider renderer={PwaThemeIcon}><PwaUpdateProvider activeSection={section}><PwaSyncProvider><AppConnectionGate section={section} onOpenFeature={switchSection}><div ref={root} className="crate-feature-shell" onTransitionEnd={event => {
		const panel = event.target as HTMLElement;
		if (event.propertyName === 'opacity' && panel.dataset.crateSection === frontSection) finishSettledSection();
	}}>
		<div className="crate-modal-canvas">
		<div className="crate-feature-panel crate-reminders-ui pwa-reading-root" data-crate-section="reading" style={panelStyle('reading')} data-front={frontSection === 'reading'} data-active={section === 'reading'} data-leaving={leavingSection === 'reading'} data-entering={section === 'reading' && leavingSection !== null} inert={section !== 'reading' || settingsOpen} aria-hidden={section !== 'reading' || settingsOpen}><FeatureNavigationContext.Provider value={{ section: 'reading', active: section === 'reading', toggle, destination, navigate, dockIndex, rememberReminderDockIndex, readingTab, rememberReadingTab }}>{features.reading ? visited.has('reading') && <ReadingFeature /> : paused('reading')}</FeatureNavigationContext.Provider></div>
		<div className="crate-feature-panel crate-reminders-ui" data-crate-section="reminders" style={panelStyle('reminders')} data-front={frontSection === 'reminders'} data-active={section === 'reminders'} data-leaving={leavingSection === 'reminders'} data-entering={section === 'reminders' && leavingSection !== null} inert={section !== 'reminders' || settingsOpen} aria-hidden={section !== 'reminders' || settingsOpen}><FeatureNavigationContext.Provider value={{ section: 'reminders', active: section === 'reminders', toggle, destination, navigate, dockIndex, rememberReminderDockIndex, readingTab, rememberReadingTab }}>{features.reminders ? visited.has('reminders') && reminders : paused('reminders')}</FeatureNavigationContext.Provider></div>
		</div>
		{settingsOpen && <div className="crate-reminders-ui pwa-shadow-root pwa-settings-root"><SettingsSheet navigation={settingsNavigation} onOpenEnd={settingsOpened} onReviewReminders={() => navigate({ section: 'reminders', tab: 'today' })} /></div>}
	</div></AppConnectionGate></PwaSyncProvider></PwaUpdateProvider></ThemeIconProvider></SharedFeaturesContext.Provider></DockMorphContext.Provider>;
}
