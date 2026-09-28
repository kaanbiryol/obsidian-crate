/** Preserve native disclosure state, scroll, and the active control across a settings save. */
export function captureSettingsView(container: HTMLElement) {
	const sections = new Map(Array.from(container.querySelectorAll<HTMLDetailsElement>('details[data-settings-section]'))
		.map(details => [details.getAttribute('data-settings-section')!, details.open]));
	const active = container.ownerDocument.activeElement;
	const row = active && container.contains(active) ? active.closest('.setting-item') : null;
	const controls = row ? Array.from(row.querySelectorAll('input, button, select, textarea, [tabindex]')) : [];
	const summary = active && container.contains(active) ? active.closest('summary')?.parentElement?.getAttribute('data-settings-section') : null;
	return { sections, scroll: container.scrollTop, summary,
		name: row?.querySelector('.setting-item-name')?.textContent,
		index: active ? controls.indexOf(active) : -1 };
}

export function restoreSettingsView(container: HTMLElement, state: ReturnType<typeof captureSettingsView>): void {
	// Parent disclosures occur first; opening them mounts lazy children synchronously.
	for (const [key, open] of state.sections) {
		const details = Array.from(container.querySelectorAll<HTMLDetailsElement>('details[data-settings-section]'))
			.find(element => element.getAttribute('data-settings-section') === key);
		if (!details) continue;
		details.open = open;
		if (open) details.dispatchEvent(new Event('toggle'));
	}
	if (state.summary) {
		Array.from(container.querySelectorAll<HTMLDetailsElement>('details[data-settings-section]'))
			.find(element => element.getAttribute('data-settings-section') === state.summary)?.querySelector('summary')?.focus({ preventScroll: true });
	} else if (state.name && state.index >= 0) {
		const row = Array.from(container.querySelectorAll('.setting-item'))
			.find(element => element.querySelector('.setting-item-name')?.textContent === state.name);
		row?.querySelectorAll<HTMLElement>('input, button, select, textarea, [tabindex]')[state.index]?.focus({ preventScroll: true });
	}
	container.scrollTop = state.scroll;
}
