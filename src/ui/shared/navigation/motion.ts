/** Nearly critical damping: quick response, a soft landing, and no visible bounce.
 * Motion carries the current velocity into a changed destination. */
export const PWA_SURFACE_SPRING = {
	type: 'spring', stiffness: 460, damping: 43, mass: 1,
	restDelta: 0.1, restSpeed: 1,
} as const;

/** Full-width navigation covers more distance and needs a slightly quicker response. */
export const PWA_NAVIGATION_SPRING = {
	...PWA_SURFACE_SPRING, stiffness: 600, damping: 49,
} as const;

/** Local feedback and stationary screen/toast dissolves; durations are seconds.
 * CSS counterparts live in ../styles/_navigation-motion.scss. Keyboard timing remains separate
 * because it follows viewport displacement rather than app navigation. */
export const PWA_FADE = { duration: 0.16, ease: 'easeOut' } as const;
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
