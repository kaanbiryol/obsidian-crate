import { useEffect, useRef, useState } from 'react';

export const INITIAL_SKELETON_DELAY_MS = 180;
export const INITIAL_SKELETON_MIN_VISIBLE_MS = 200;

export type InitialLoadingPhase = 'pending' | 'visible' | 'complete';

interface InitialLoadingTransition {
	phase: InitialLoadingPhase;
	showLoadingContent: boolean;
	isSkeletonVisible: boolean;
}

interface PwaLoadingWindow extends Window {
	__CRATE_PWA_LOADING_STARTED_AT__?: number;
}

function nowMs(): number {
	return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function loadingStartedAt(): number {
	if (typeof window === 'undefined') return nowMs();
	const startedAt = (window as PwaLoadingWindow).__CRATE_PWA_LOADING_STARTED_AT__;
	return typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : nowMs();
}

export function initialLoadingPhase(ready: boolean, elapsedMs: number): InitialLoadingPhase {
	if (ready) return 'complete';
	return elapsedMs >= INITIAL_SKELETON_DELAY_MS ? 'visible' : 'pending';
}

export function remainingSkeletonMinimumMs(visibleAt: number, currentTime: number): number {
	return Math.max(0, INITIAL_SKELETON_MIN_VISIBLE_MS - (currentTime - visibleAt));
}

export function useInitialLoadingTransition(ready: boolean): InitialLoadingTransition {
	const startedAtRef = useRef(loadingStartedAt());
	const initialNowRef = useRef(nowMs());
	const initialPhaseRef = useRef(initialLoadingPhase(
		ready,
		initialNowRef.current - startedAtRef.current,
	));
	const [phase, setPhase] = useState<InitialLoadingPhase>(initialPhaseRef.current);
	const visibleAtRef = useRef<number | null>(
		initialPhaseRef.current === 'visible'
			? startedAtRef.current + INITIAL_SKELETON_DELAY_MS
			: null,
	);

	useEffect(() => {
		if (phase !== 'pending') return;
		if (ready) {
			setPhase('complete');
			return;
		}

		const remainingDelay = Math.max(
			0,
			startedAtRef.current + INITIAL_SKELETON_DELAY_MS - nowMs(),
		);
		const timer = window.setTimeout(() => {
			visibleAtRef.current = nowMs();
			setPhase('visible');
		}, remainingDelay);
		return () => window.clearTimeout(timer);
	}, [phase, ready]);

	useEffect(() => {
		if (phase !== 'visible' || !ready) return;
		const visibleAt = visibleAtRef.current ?? nowMs();
		const timer = window.setTimeout(() => {
			setPhase('complete');
		}, remainingSkeletonMinimumMs(visibleAt, nowMs()));
		return () => window.clearTimeout(timer);
	}, [phase, ready]);

	return {
		phase,
		showLoadingContent: phase !== 'complete',
		isSkeletonVisible: phase === 'visible',
	};
}
