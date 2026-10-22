import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react';
import { useSettingsOpen } from '../settings/settings-context';
import { FeatureSwitcherButton } from './FeatureSwitcherButton';
import { PwaButton } from './PwaButton';

class FeatureLoadBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() { return { failed: true }; }
	render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

type FeatureModule = { default: ComponentType };

/** Share one chunk request between a background preload and the first mount. */
export function featureLoader(importFeature: () => Promise<FeatureModule>) {
	let pending: Promise<FeatureModule> | undefined;
	let loaded: ComponentType | undefined;
	return {
		load: () => pending ??= importFeature().then(module => { loaded = module.default; return module; },
			(error: unknown) => { pending = undefined; throw error; }),
		loaded: () => loaded,
	};
}

export type FeatureLoader = ReturnType<typeof featureLoader>;

/** A missing screen chunk must not unmount sync, the other feature or settings. */
export function LazyPwaFeature({ name, feature, opening }: {
	name: 'Reading' | 'Reminders';
	feature: FeatureLoader;
	opening: ReactNode;
}) {
	const [, setSettingsOpen] = useSettingsOpen();
	// A preloaded feature mounts directly, without a loading frame.
	const [attempt, setAttempt] = useState(() => ({ id: 0, View: feature.loaded() ?? lazy(feature.load) }));
	const retry = () => setAttempt(current => ({ id: current.id + 1, View: lazy(feature.load) }));
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
