/** Session markers that carry an update reload across the page load. The Worker's pre-JS
 * theme bootstrap reads them, so this module stays free of DOM code. */
export const PWA_UPDATE_TRANSITION_KEY = 'crate-pwa-update-transition';
export const PWA_UPDATE_TRANSITION_POSITION_KEY = 'crate-pwa-update-position';
export const PWA_UPDATE_TRANSITION_MAX_AGE_MS = 60_000;
export const PWA_UPDATE_OPENING_PROGRESS = 0.9;
