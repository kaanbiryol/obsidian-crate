import type { AnimationConfig } from '../types/componentAdapter';

// Re-export AnimationConfig for convenience
export type { AnimationConfig };

// Check for reduced motion preference (evaluated once at module load, refreshed on call)
export const prefersReducedMotion = (): boolean => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

/**
 * iOS-native spring configurations
 * Based on UIKit's UISheetPresentationController and UIAlertController physics
 *
 * iOS uses nearly critically-damped springs for a smooth, professional feel.
 * Critical damping ratio = 2 * sqrt(stiffness * mass)
 * We use slightly underdamped (damping ~0.9-0.95 of critical) for subtle spring feel.
 */
export const IOS_SPRING = {
    // Bottom sheet (UISheetPresentationController-style)
    // Nearly critically-damped for smooth, professional slide
    bottomSheet: {
        type: 'spring' as const,
        mass: 1,
        stiffness: 500,
        damping: 48,
        restDelta: 0.01,
        restSpeed: 0.01,
    },

    // Alert/centered modal (subtle overshoot on entry)
    alert: {
        type: 'spring' as const,
        mass: 0.8,
        stiffness: 500,
        damping: 42,
        restDelta: 0.01,
        restSpeed: 0.01,
    },

    // Quick spring for micro-interactions (tabs, buttons)
    quick: {
        type: 'spring' as const,
        stiffness: 600,
        damping: 40,
        mass: 0.5,
        restDelta: 0.01,
        restSpeed: 0.01,
    },

    // Gentle spring for list item reordering
    list: {
        type: 'spring' as const,
        stiffness: 350,
        damping: 35,
        mass: 0.8,
        restDelta: 0.01,
        restSpeed: 0.01,
    },
} as const;

/**
 * Exit transitions - no spring, quick ease for dismissal
 * iOS uses ease-in curves for dismiss (accelerate away)
 * Faster exits (0.15s) for snappier modal switching
 */
export const IOS_EXIT = {
    bottomSheet: {
        type: 'tween' as const,
        duration: 0.15,
        ease: [0.32, 0, 0.67, 0] as const, // ease-in for dismissal
    },
    alert: {
        type: 'tween' as const,
        duration: 0.15,
        ease: [0.32, 0, 0.67, 0] as const,
    },
    list: {
        type: 'tween' as const,
        duration: 0.15,
        ease: [0.32, 0, 0.67, 0] as const,
    },
} as const;

/**
 * Backdrop timing - faster than modal for perceived performance
 */
export const BACKDROP_ANIMATION = {
    enter: { duration: 0.18, ease: 'easeOut' as const },
    exit: { duration: 0.12, ease: 'easeIn' as const },
} as const;
