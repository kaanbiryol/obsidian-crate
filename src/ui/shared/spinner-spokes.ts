/** Shared geometry for React spinners and the pre-JavaScript launch screen. */
export const SPINNER_SPOKES = Array.from({ length: 12 }, (_, index) => ({
	transform: `rotate(${index * 30} 12 12)`,
	opacity: (index + 1) / 12,
}));

export const SPINNER_SPOKES_HTML = SPINNER_SPOKES.map(({ transform, opacity }) =>
	`<rect x="11" y="2" width="2" height="5" rx="1" fill="currentColor" transform="${transform}" opacity="${opacity}"></rect>`,
).join('');
