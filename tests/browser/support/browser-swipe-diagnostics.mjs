import { mkdir, writeFile } from 'node:fs/promises';

export async function recordSwipeDiagnostics(page) {
	await page.addInitScript(() => {
		window.crateSwipeEvents = [];
		for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointermove', 'pointerup']) {
			document.addEventListener(type, event => {
				const target = event.target;
				const popup = target.closest?.('.pwa-modal-sheet__container');
				const touch = event.touches?.[0] ?? event.changedTouches?.[0];
				const ancestors = [];
				for (let element = target; element instanceof Element; element = element.parentElement) {
					ancestors.push({ tag: element.tagName, class: element.className, scrollTop: element.scrollTop,
						ignoreSwipe: element.hasAttribute('data-base-ui-swipe-ignore'),
						height: element.clientHeight, scrollHeight: element.scrollHeight });
				}
				const entry = { type, time: event.timeStamp, now: performance.now(), pointerType: event.pointerType, buttons: event.buttons,
					x: touch?.clientX ?? event.clientX, y: touch?.clientY ?? event.clientY, ancestors,
					popup: popup ? { attributes: Object.fromEntries([...popup.attributes].map(a => [a.name, a.value])),
						transform: getComputedStyle(popup).transform } : null };
				window.crateSwipeEvents.push(entry);
				if (window.crateSwipeEvents.length > 300) window.crateSwipeEvents.shift();
				queueMicrotask(() => { entry.prevented = event.defaultPrevented; });
			}, { capture: true, passive: true });
		}
	});
}

export async function saveSwipeFailure(page, browserName) {
	const directory = `.generated/browser-failures/drawer-swipe-${browserName}`;
	await mkdir(directory, { recursive: true });
	const results = await Promise.allSettled([
		page.screenshot({ path: `${directory}/failure.png`, fullPage: true }),
		page.evaluate(() => window.crateSwipeEvents).then(events => writeFile(`${directory}/events.json`, JSON.stringify(events, null, 2))),
	]);
	for (const result of results) if (result.status === 'rejected') console.error('Could not save swipe diagnostic:', result.reason);
	console.error(`Swipe diagnostics saved to ${directory}`);
}
