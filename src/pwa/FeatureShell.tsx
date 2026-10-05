import { useFeatureNavigation } from './hooks/useFeatureNavigation';
import { AppConnectionGate } from './connection/AppConnectionGate';
import { PwaSyncProvider } from './sync/PwaSyncProvider';
import { SharedFeaturesContext, useServerFeatures } from './shared-features';
import { Button } from '@/ui/shared/Button';
import { PwaUpdateProvider } from './components/PwaUpdateProvider';
import React, { useState } from 'react';
import { FeatureNavigationContext, type CrateSection } from './components/FeatureSwitcherButton';
import { ThemeIconProvider } from '@/ui/shared/ThemeIcon';
import { PwaThemeProvider } from './components/PwaThemeProvider';
import { PwaThemeIcon } from './components/PwaThemeIcon';
import { usePwaInputModality } from './hooks/usePwaInputModality';
import { ReadingFeature } from './reading/ReadingFeature';
import { createSettingsStore } from './settings-store';
import { SettingsContext, useSettingsStore } from './settings-context';
import { SettingsSheet } from './components/SettingsSheet';
import { DockMorphContext, useDockMorphState } from '@/ui/shared/navigation/useDockMorph';

export function FeatureShell({ reminders }: { reminders: React.ReactNode }) {
	const [settings] = useState(() => createSettingsStore(new URL(location.href).searchParams.get('setup') === 'shortcut'));
	return <PwaThemeProvider><SettingsContext.Provider value={settings}><FeatureShellContent reminders={reminders} /></SettingsContext.Provider></PwaThemeProvider>;
}

function FeatureShellContent({ reminders }: { reminders: React.ReactNode }) {
	const features = useServerFeatures();
	const dockMorph = useDockMorphState();
	usePwaInputModality();
	const settings = useSettingsStore();
	const {
		root, section, destination, settingsOpen, settingsNavigation, settingsOpened,
		frontSection, leavingSection, visited, panelStyle, finishSettledSection,
		switchSection, navigate, toggle, dockIndex, rememberReminderDockIndex, readingTab, rememberReadingTab,
	} = useFeatureNavigation(features);
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
