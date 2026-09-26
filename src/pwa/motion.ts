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
