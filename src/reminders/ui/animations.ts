import type { AnimationConfig } from '../types/componentAdapter';

// Re-export AnimationConfig for convenience
export type { AnimationConfig };

// Check for reduced motion preference (evaluated once at module load, refreshed on call)
export const prefersReducedMotion = (): boolean => {
    if (typeof document !== 'undefined' && document.body?.classList.contains('reduce-motion')) {
        return true;
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};
