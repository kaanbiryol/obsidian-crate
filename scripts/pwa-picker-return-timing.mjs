import assert from 'node:assert/strict';

// Desktop engines cannot animate an iPhone keyboard. Report its final viewport
// at focus time and record the real sheet frames relative to that same gesture.
export async function checkPickerReturnTiming(page, reducedMotion, label) {
	await page.evaluate(() => {
		window.pickerReturnFrames = [];
		window.pickerReturnComplete = false;
		window.pickerReturnFocusedAt = null;
		let started;
		let keyboardInset = 0;
		const viewport = window.visualViewport;
		Object.defineProperty(viewport, 'height', { configurable: true, get: () => window.innerHeight - keyboardInset });
		const focus = event => {
			if (!event.target.closest('.pwa-reminder-sheet-screen--editor')) return;
			window.pickerReturnFocusedAt = performance.now() - started;
			keyboardInset = 320;
			viewport.dispatchEvent(new Event('resize'));
		};
		document.addEventListener('focusin', focus, true);
		document.addEventListener('click', () => { started = performance.now(); }, { once: true, capture: true });
		function sample() {
			if (started !== undefined) {
				const stage = document.querySelector('.pwa-reminder-sheet-stage');
				const transform = getComputedStyle(stage).transform;
				window.pickerReturnFrames.push({
					time: performance.now() - started,
					active: Boolean(stage.querySelector('.pwa-reminder-sheet-screen--editor.is-active')),
					y: transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42,
					top: stage.getBoundingClientRect().top,
				});
			}
			if (started === undefined || performance.now() - started < 650) requestAnimationFrame(sample);
			else {
				document.removeEventListener('focusin', focus, true);
				delete viewport.height;
				viewport.dispatchEvent(new Event('resize'));
				window.pickerReturnComplete = true;
			}
		}
		requestAnimationFrame(sample);
	});
	await page.touchscreen.tap(195, 20);
	await page.waitForFunction(() => window.pickerReturnComplete);
	const { frames, focusedAt } = await page.evaluate(() => ({
		frames: window.pickerReturnFrames, focusedAt: window.pickerReturnFocusedAt,
	}));
	assert.ok(focusedAt !== null && focusedAt < 80, `${label}: restore focus inside the return gesture (${focusedAt} ms)`);
	const editor = frames.filter(frame => frame.active);
	assert.ok(editor[0]?.time < 160, `${label}: editor must start returning promptly (${editor[0]?.time} ms)`);
	const finalTop = editor.at(-1).top;
	const settled = editor.find(frame => frame.y < 1 && Math.abs(frame.top - finalTop) < 1);
	assert.ok(settled?.time < (reducedMotion === 'reduce' ? 160 : 590),
		`${label}: return must finish without an extra pause (${settled?.time} ms)`);
	if (reducedMotion === 'no-preference') {
		assert.ok(editor.filter(frame => frame.y > 10).length >= 3,
			`${label}: returning editor must still animate`);
		assert.ok(settled.time - editor[0].time > 310,
			`${label}: editor should retain the other sheets' gentle entrance, not rush to catch the keyboard`);
	}
	for (const frame of editor.filter(frame => frame.time >= settled.time)) {
		assert.ok(Math.abs(frame.top - finalTop) < 1, `${label}: no late position correction after the return settles`);
	}
	console.log(`${label}: focus ${Math.round(focusedAt)} ms, editor ${Math.round(editor[0].time)} ms, settled ${Math.round(settled.time)} ms`);
}
