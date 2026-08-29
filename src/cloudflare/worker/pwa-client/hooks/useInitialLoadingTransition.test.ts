import { describe, expect, it } from 'vitest';
import {
	INITIAL_SKELETON_DELAY_MS,
	INITIAL_SKELETON_MIN_VISIBLE_MS,
	initialLoadingPhase,
	remainingSkeletonMinimumMs,
} from './useInitialLoadingTransition';

describe('initial loading transition timing', () => {
	it('skips the skeleton when content is ready during the reveal delay', () => {
		expect(initialLoadingPhase(true, INITIAL_SKELETON_DELAY_MS - 1)).toBe('complete');
	});

	it('reveals the skeleton only after the delay', () => {
		expect(initialLoadingPhase(false, INITIAL_SKELETON_DELAY_MS - 1)).toBe('pending');
		expect(initialLoadingPhase(false, INITIAL_SKELETON_DELAY_MS)).toBe('visible');
	});

	it('keeps a visible skeleton long enough to avoid a flash', () => {
		expect(remainingSkeletonMinimumMs(1_000, 1_050)).toBe(INITIAL_SKELETON_MIN_VISIBLE_MS - 50);
		expect(remainingSkeletonMinimumMs(1_000, 1_500)).toBe(0);
	});
});
