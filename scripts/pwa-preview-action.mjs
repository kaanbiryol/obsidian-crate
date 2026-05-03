export function withPreviewAction(html, action, project) {
	if (!action) {
		return html;
	}

	const escapedProject = JSON.stringify(project || '');
	const escapedAction = JSON.stringify(action);
	const script = `
<script>
window.addEventListener('load', () => {
	const action = ${escapedAction};
	const project = ${escapedProject};
	const click = (selector) => {
		const el = document.querySelector(selector);
		if (el) el.click();
	};
	const openProject = () => {
		const buttons = Array.from(document.querySelectorAll('[data-action="open-project"]'));
		const match = buttons.find((button) => button.getAttribute('data-project') === project);
		if (match) match.click();
	};
	const openFirstReminder = () => {
		const card = document.querySelector('.premium-reminder-card');
		if (card) card.click();
	};
	const dispatchTouch = (target, type, y) => {
		if (!target) return;
		let event;
		try {
			const touch = new Touch({
				identifier: 1,
				target,
				clientX: Math.round(window.innerWidth / 2),
				clientY: y,
				pageX: Math.round(window.innerWidth / 2),
				pageY: y,
			});
			event = new TouchEvent(type, {
				bubbles: true,
				cancelable: true,
				touches: type === 'touchend' ? [] : [touch],
				targetTouches: type === 'touchend' ? [] : [touch],
				changedTouches: [touch],
			});
		} catch {
			event = new Event(type, { bubbles: true, cancelable: true });
			Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientY: y }] });
			Object.defineProperty(event, 'changedTouches', { value: [{ clientY: y }] });
		}
		target.dispatchEvent(event);
	};
	const previewPullRefresh = () => {
		const scroll = document.querySelector('.pwa-reminders-view .ios-scroll');
		if (!scroll) return;
		scroll.scrollTop = 0;
		dispatchTouch(scroll, 'touchstart', 96);
		setTimeout(() => dispatchTouch(scroll, 'touchmove', 236), 40);
	};
	const run = () => {
		switch (action) {
			case 'create':
				click('[data-action="open-create-modal"]');
				break;
			case 'edit':
				openFirstReminder();
				break;
			case 'edit-today':
				click('[data-action="switch-tab"][data-tab="today"]');
				setTimeout(openFirstReminder, 160);
				break;
			case 'settings':
				click('[data-action="toggle-settings"]');
				break;
			case 'today':
			case 'upcoming':
			case 'projects':
				click('[data-action="switch-tab"][data-tab="' + action + '"]');
				break;
			case 'project':
				click('[data-action="switch-tab"][data-tab="projects"]');
				setTimeout(openProject, 120);
				break;
			case 'pull':
				previewPullRefresh();
				break;
		}
	};
	setTimeout(run, 120);
	setTimeout(run, 480);
});
</script>`;

	return html.replace('</body>', `${script}</body>`);
}
