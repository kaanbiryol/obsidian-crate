/** Start a JSON download. Callers still own payload formats and saved-copy review. */
export function downloadJson(filename: string, payload: unknown): void {
	const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	try {
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		link.click();
	} finally {
		// Give the browser time to consume the URL, including on mobile Safari.
		window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
	}
}
