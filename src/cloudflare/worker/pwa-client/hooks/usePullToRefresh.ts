import { useEffect, useRef, useState } from 'react';
import type { PullRefreshState } from '../types';

const PULL_REFRESH_THRESHOLD = 70;
const PULL_REFRESH_MAX_DISTANCE = 120;
const PULL_REFRESH_SNAP_DISTANCE = 58;

function findPullScrollTarget(target: EventTarget | null): HTMLElement | null {
	if (!(target instanceof Element)) return null;
	const targetScroll = target.closest<HTMLElement>('.pwa-reminders-view .ios-scroll');
	if (targetScroll) return targetScroll;
	return document.querySelector<HTMLElement>('.pwa-reminders-view .ios-scroll');
}

function dampenPullDistance(distance: number): number {
	const ratio = Math.min(distance / PULL_REFRESH_MAX_DISTANCE, 1);
	return PULL_REFRESH_MAX_DISTANCE * (1 - Math.pow(1 - ratio, 2));
}

export function usePullToRefresh(enabled: boolean, onRefresh: () => Promise<void>): PullRefreshState {
	const [state, setState] = useState<PullRefreshState>({ distance: 0, progress: 0, ready: false, refreshing: false });
	const refreshRef = useRef(onRefresh);

	useEffect(() => {
		refreshRef.current = onRefresh;
	}, [onRefresh]);

	useEffect(() => {
		if (!enabled) {
			setState({ distance: 0, progress: 0, ready: false, refreshing: false });
			return;
		}

		let startY = 0;
		let active = false;
		let pulling = false;
		let currentDistance = 0;
		let animationFrame: number | null = null;

		const reset = () => {
			active = false;
			pulling = false;
			currentDistance = 0;
			if (animationFrame !== null) {
				window.cancelAnimationFrame(animationFrame);
				animationFrame = null;
			}
			setState({ distance: 0, progress: 0, ready: false, refreshing: false });
		};

		const handleTouchStart = (event: TouchEvent) => {
			if (event.touches.length !== 1) return;
			if ((event.target as Element | null)?.closest('.modal-backdrop, .settings-sheet, .settings-backdrop')) return;
			const scrollTarget = findPullScrollTarget(event.target);
			if (!scrollTarget || scrollTarget.scrollTop > 0) return;

			startY = event.touches[0].clientY;
			active = true;
			pulling = false;
			currentDistance = 0;
		};

		const handleTouchMove = (event: TouchEvent) => {
			if (!active || event.touches.length !== 1) return;
			const scrollTarget = findPullScrollTarget(event.target);
			if (!scrollTarget || scrollTarget.scrollTop > 0) {
				reset();
				return;
			}

			const delta = event.touches[0].clientY - startY;
			if (delta <= 0) {
				reset();
				return;
			}

			pulling = true;
			currentDistance = Math.min(PULL_REFRESH_MAX_DISTANCE, Math.round(dampenPullDistance(delta)));
			if (currentDistance > 8) event.preventDefault();

			if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
			animationFrame = window.requestAnimationFrame(() => {
				setState({
					distance: currentDistance,
					progress: Math.min(currentDistance / PULL_REFRESH_THRESHOLD, 1),
					ready: currentDistance >= PULL_REFRESH_THRESHOLD,
					refreshing: false,
				});
				animationFrame = null;
			});
		};

		const handleTouchEnd = () => {
			if (animationFrame !== null) {
				window.cancelAnimationFrame(animationFrame);
				animationFrame = null;
			}

			if (!pulling) {
				reset();
				return;
			}

			if (currentDistance < PULL_REFRESH_THRESHOLD) {
				reset();
				return;
			}

			active = false;
			pulling = false;
			currentDistance = 0;
			setState({ distance: PULL_REFRESH_SNAP_DISTANCE, progress: 1, ready: true, refreshing: true });
			void refreshRef.current().finally(() => {
				window.setTimeout(() => {
					setState({ distance: 0, progress: 0, ready: false, refreshing: false });
				}, 360);
			});
		};

		document.addEventListener('touchstart', handleTouchStart, { passive: true });
		document.addEventListener('touchmove', handleTouchMove, { passive: false });
		document.addEventListener('touchend', handleTouchEnd);
		document.addEventListener('touchcancel', reset);
		return () => {
			document.removeEventListener('touchstart', handleTouchStart);
			document.removeEventListener('touchmove', handleTouchMove);
			document.removeEventListener('touchend', handleTouchEnd);
			document.removeEventListener('touchcancel', reset);
			if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
		};
	}, [enabled]);

	return state;
}
