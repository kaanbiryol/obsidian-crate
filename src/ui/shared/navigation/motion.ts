/** Nearly critical damping: quick response, a soft landing, and no visible bounce.
 * Motion carries the current velocity into a changed destination. */
export const PWA_SURFACE_SPRING = {
	type: 'spring', stiffness: 460, damping: 43, mass: 1,
	restDelta: 0.1, restSpeed: 1,
} as const;

/** The dock grows into its view menu with a soft overshoot of a few pixels,
 * like a native control expanding; closing uses PWA_DOCK_COLLAPSE_SPRING. */
export const PWA_DOCK_EXPAND_SPRING = {
	...PWA_SURFACE_SPRING, stiffness: 420, damping: 30,
} as const;

/** The view menu shrinks back into the bar quickly and without bounce, so the
 * chosen screen's dissolve reads as following the menu's collapse. */
export const PWA_DOCK_COLLAPSE_SPRING = {
	...PWA_SURFACE_SPRING, stiffness: 700, damping: 53,
} as const;

/** Full-width navigation covers more distance and needs a slightly quicker response. */
export const PWA_NAVIGATION_SPRING = {
	...PWA_SURFACE_SPRING, stiffness: 600, damping: 49,
} as const;

/** Every stationary fade (screens, content reveals, list rows, empty states and toasts);
 * durations are seconds. Mirrors --pwa-motion-fade-duration and --pwa-motion-fade-ease in
 * ../styles/_navigation-motion.scss. Keyboard timing remains separate because it follows
 * viewport displacement rather than app navigation. */
export const PWA_FADE = { duration: 0.27, ease: [0.22, 1, 0.36, 1] as const };
/** PWA_FADE for Web Animations, which take milliseconds and CSS easing strings. */
export const PWA_FADE_TIMING = { duration: PWA_FADE.duration * 1000, easing: `cubic-bezier(${PWA_FADE.ease.join(', ')})` } as const;
export const PWA_CONTROL_SPRING = {
	...PWA_SURFACE_SPRING, stiffness: 700, damping: 53,
} as const;

/** The picker handoff keeps focus restoration inside the initiating gesture. */
export const PWA_PICKER_EXIT = { duration: 0.18, ease: [0.4, 0, 1, 1] } as const;
export const PWA_PICKER_RETURN = { ...PWA_PICKER_EXIT, duration: 0.08 } as const;

export const SPRING_CONFIG = {
	stiffness: 500,
	damping: 40,
	mass: 0.8
} as const;
