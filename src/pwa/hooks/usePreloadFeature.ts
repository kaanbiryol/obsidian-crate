import { useEffect } from 'react';
import type { SharedFeatures } from '@/protocol/feature-policy';
import type { CrateSection } from '../navigation/feature-navigation';
import { readingFeature } from '../reading/ReadingFeature';
import { remindersFeature } from '../reminders/RemindersFeature';

const loaders = { reading: readingFeature, reminders: remindersFeature };

/** Load the other feature once the open one is ready, so the first switch does not wait on its chunk. */
export function usePreloadFeature(section: CrateSection, visited: ReadonlySet<CrateSection>, features: SharedFeatures): void {
	const other = section === 'reading' ? 'reminders' : 'reading';
	const wanted = features[section] && features[other] && !visited.has(other);
	useEffect(() => {
		if (!wanted || loaders[other].loaded()) return;
		let active = true, cancel = () => {};
		const preload = () => { if (active) void loaders[other].load().catch(() => undefined); };
		void loaders[section].load().then(() => {
			if (!active) return;
			if (typeof window.requestIdleCallback === 'function') {
				const id = window.requestIdleCallback(preload);
				cancel = () => window.cancelIdleCallback(id);
			} else {
				// Let browsers without idle callbacks paint the open feature first.
				const id = window.setTimeout(preload, 200);
				cancel = () => window.clearTimeout(id);
			}
		}, () => undefined);
		return () => { active = false; cancel(); };
	}, [section, other, wanted]);
}
