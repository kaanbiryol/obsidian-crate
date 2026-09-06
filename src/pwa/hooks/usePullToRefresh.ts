import { useEffect, useRef, useState } from 'react';
import type { PullRefreshState } from '../types';

const PULL_REFRESH_THRESHOLD = 70;
const PULL_REFRESH_MAX_DISTANCE = 120;
const PULL_REFRESH_SNAP_DISTANCE = 58;
function findPullScrollTarget(target: EventTarget | null): HTMLElement | null {
	if (!(target instanceof Element)) return null;
	const targetScroll = target.closest<HTMLElement>('.pwa-reminders-view .ios-scroll');
	if (targetScroll) return targetScroll;
	return null;
}

function dampenPullDistance(distance: number): number {
	return PULL_REFRESH_MAX_DISTANCE * distance / (distance + PULL_REFRESH_MAX_DISTANCE);
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
		let startX = 0;
		let refreshing = false;
		let disposed = false;
		let active = false;
		let pulling = false;
		let currentDistance = 0;
		let animationFrame: number | null = null;
		let scrollTarget: HTMLElement | null = null;
		let settleTimeout: number | null = null;

		const detachGestureListeners = () => {
			if (!scrollTarget) return;
			scrollTarget.removeEventListener('touchmove', handleTouchMove);
			scrollTarget.removeEventListener('touchend', handleTouchEnd);
			scrollTarget.removeEventListener('touchcancel', reset);
			scrollTarget = null;
		};

		function reset() {
			active = false;
			pulling = false;
			currentDistance = 0;
			if (animationFrame !== null) {
				window.cancelAnimationFrame(animationFrame);
				animationFrame = null;
			}
			detachGestureListeners();
			setState({ distance: 0, progress: 0, ready: false, refreshing: false });
		}

		function handleTouchStart(event: TouchEvent) {
			if (refreshing || active || event.touches.length !== 1) return;
			if ((event.target as Element | null)?.closest('.react-modal-sheet-root')) return;
			const nextScrollTarget = findPullScrollTarget(event.target);
			if (!nextScrollTarget || nextScrollTarget.scrollTop > 0) return;

			const touch = event.touches.item(0);
			if (!touch) return;
			startY = touch.clientY;
			startX = touch.clientX;
			active = true;
			pulling = false;
			currentDistance = 0;
			scrollTarget = nextScrollTarget;
			scrollTarget.addEventListener('touchmove', handleTouchMove, { passive: false });
			scrollTarget.addEventListener('touchend', handleTouchEnd);
			scrollTarget.addEventListener('touchcancel', reset);
		}

		function handleTouchMove(event: TouchEvent) {
			if (!active || event.touches.length !== 1) return;
			if (!scrollTarget || scrollTarget.scrollTop > 0) {
				reset();
				return;
			}

			const touch = event.touches.item(0);
			if (!touch) return;
			const delta = touch.clientY - startY;
			if (delta <= 0 || (!pulling && Math.abs(touch.clientX - startX) > delta)) {
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
		}

		function handleTouchEnd() {
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
			detachGestureListeners();
			refreshing = true;
			setState({ distance: PULL_REFRESH_SNAP_DISTANCE, progress: 1, ready: true, refreshing: true });
			void Promise.resolve().then(() => refreshRef.current()).catch(() => {
				// The refresh callback owns the user-facing error state.
			}).finally(() => {
				if (disposed) return;
				settleTimeout = window.setTimeout(() => {
					refreshing = false;
					setState({ distance: 0, progress: 0, ready: false, refreshing: false });
				}, 360);
			});
		}

		document.addEventListener('touchstart', handleTouchStart, { passive: true });
		return () => {
			disposed = true;
			document.removeEventListener('touchstart', handleTouchStart);
			detachGestureListeners();
			if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
			if (settleTimeout !== null) window.clearTimeout(settleTimeout);
		};
	}, [enabled]);

	return state;
}
