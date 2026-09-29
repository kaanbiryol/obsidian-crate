// Respect the system preference and the plugin host’s reduce-motion class.
export const prefersReducedMotion = (): boolean => {
    if (typeof document !== 'undefined' && document.body?.classList.contains('reduce-motion')) {
        return true;
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};
