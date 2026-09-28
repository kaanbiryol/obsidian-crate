import { afterEach, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { captureSettingsView, restoreSettingsView } from './settings-view-state';

afterEach(() => vi.unstubAllGlobals());

it('restores expanded lazy sections, control focus, and scroll after a save', () => {
	const { document, window } = parseHTML('<html><body><div id="settings"><details data-settings-section="Server"><summary>Server · old summary</summary><div class="setting-item"><div class="setting-item-name">Server address</div><input></div></details></div></body></html>');
	vi.stubGlobal('Event', window.Event);
	const container = document.getElementById('settings')!;
	container.querySelector('details')!.open = true;
	Object.defineProperty(document, 'activeElement', { configurable: true, value: container.querySelector('input') });
	container.scrollTop = 140;
	const state = captureSettingsView(container);
	const replacement = document.createElement('details');
	replacement.setAttribute('data-settings-section', 'Server');
	const summary = document.createElement('summary');
	summary.textContent = 'Server · changed summary';
	replacement.append(summary);
	container.replaceChildren(replacement);
	const focus = vi.fn();
	const details = container.querySelector('details')!;
	details.addEventListener('toggle', () => {
		const row = document.createElement('div');
		row.className = 'setting-item';
		const name = document.createElement('div');
		name.className = 'setting-item-name';
		name.textContent = 'Server address';
		const input = document.createElement('input');
		input.focus = focus;
		row.append(name, input);
		details.append(row);
	});
	restoreSettingsView(container, state);
	expect(details.open).toBe(true);
	expect(focus).toHaveBeenCalledWith({ preventScroll: true });
	expect(container.scrollTop).toBe(140);
});
