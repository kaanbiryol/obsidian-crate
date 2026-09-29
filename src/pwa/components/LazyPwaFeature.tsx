import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react';
import { useSettingsOpen } from '../settings-context';
import { FeatureSwitcherButton } from './FeatureSwitcherButton';
import { PwaButton } from './PwaButton';

class FeatureLoadBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() { return { failed: true }; }
	render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** A missing screen chunk must not unmount sync, the other feature or settings. */
export function LazyPwaFeature({ name, load, opening }: {
	name: 'Reading' | 'Reminders';
	load: () => Promise<{ default: ComponentType }>;
	opening: ReactNode;
}) {
	const [, setSettingsOpen] = useSettingsOpen();
	const [attempt, setAttempt] = useState(() => ({ id: 0, View: lazy(load) }));
	const retry = () => setAttempt(current => ({ id: current.id + 1, View: lazy(load) }));
	const fallback = <main className="pwa-screen"><section className="crate-reading crate-reading-welcome">
		<div className="pwa-feature-welcome-action"><FeatureSwitcherButton /></div>
		<h1>{name} is unavailable</h1><p role="alert">{name} could not open. Reconnect and retry. Saved data is still on this device.</p>
		<PwaButton size="touch" onClick={retry}>Retry {name}</PwaButton>
		<PwaButton size="touch" onClick={() => setSettingsOpen(true)}>Open settings</PwaButton>
	</section></main>;
	return <FeatureLoadBoundary key={attempt.id} fallback={fallback}>
		<Suspense fallback={opening}><attempt.View /></Suspense>
	</FeatureLoadBoundary>;
}
