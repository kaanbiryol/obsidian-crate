import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { useFeatureSettings, useSettingsOpen } from '../settings-context';
import { FeatureSwitcherButton } from '../components/FeatureSwitcherButton';
import { PwaButton } from '../components/PwaButton';
import { ReadingOpening } from './ReadingOpening';
import { exportReadingData } from './storage';
import { logoutReadingApp } from './logout';

class ReadingLoadBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() { return { failed: true }; }
	render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function ReadingUnavailable({ onRetry }: { onRetry: () => void }) {
	const [, setSettingsOpen] = useSettingsOpen();
	const [error, setError] = useState<string | null>(null);
	const message = 'Reading could not open. Reconnect and retry. Saved data is still on this device.';
	useFeatureSettings('reading', {
		ready: true, connected: false, unavailable: message,
		status: { state: 'error', label: message }, attention: message, unsynced: true,
		onRefresh: async () => onRetry(), onExport: exportReadingData,
		onLogout: async () => { setSettingsOpen(false); setError(await logoutReadingApp()); },
		shortcut: null, issues: null,
	});
	return <main className="pwa-screen crate-reading-web"><section className="crate-reading crate-reading-welcome">
		<div className="pwa-feature-welcome-action"><FeatureSwitcherButton /></div>
		<h1>Reading is unavailable</h1><p role="alert">{error ?? message}</p>
		<PwaButton size="touch" onClick={onRetry}>Retry Reading</PwaButton>
		<PwaButton size="touch" onClick={() => setSettingsOpen(true)}>Open settings</PwaButton>
	</section></main>;
}

/** A failed offline chunk must not unmount the other feature or shared settings. */
export function ReadingFeature() {
	const [attempt, setAttempt] = useState(() => ({ id: 0, View: lazy(() => import('./App')) }));
	const retry = () => setAttempt(current => ({ id: current.id + 1, View: lazy(() => import('./App')) }));
	return <ReadingLoadBoundary key={attempt.id} fallback={<ReadingUnavailable onRetry={retry} />}>
		<Suspense fallback={<ReadingOpening />}><attempt.View /></Suspense>
	</ReadingLoadBoundary>;
}
