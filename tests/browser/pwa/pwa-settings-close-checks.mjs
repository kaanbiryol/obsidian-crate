import { expect } from '@playwright/test';

export async function checkSettingsClose(sheet) {
	// A reversed entrance has a shortened CSS transition. This check measures
	// a full exit, so wait for the sheet's actual resting transform first.
	await expect(sheet).toHaveCSS('transform', 'none');
	const result = await sheet.getByRole('button', { name: 'Close settings', exact: true }).evaluate(button => {
		const popup = button.closest('[role="dialog"]');
		const background = document.querySelector('[data-crate-section="reminders"]');
		const canvas = document.querySelector('.crate-modal-canvas');
		const backdrop = popup.closest('.pwa-modal-sheet').querySelector('.pwa-modal-sheet__backdrop');
		return new Promise((resolve, reject) => {
			const observer = new MutationObserver(sample);
			const timeout = setTimeout(() => finish(new Error('Settings never entered its closing state')), 5000);
			function finish(error, result) {
				observer.disconnect(); clearTimeout(timeout);
				if (error) reject(error); else resolve(result);
			}
			function sample() {
				if (!popup.isConnected) { finish(new Error('Settings unmounted without a closing transition')); return; }
				if (!popup.hasAttribute('data-ending-style')) return;
				// Observe the attribute before the next frame, then seek the real CSS
				// transition. rAF sampling can miss the entire exit on a loaded host.
				const animations = [popup, canvas, backdrop].flatMap(element => element.getAnimations());
				const closing = animations.find(animation => animation.effect.target === popup && animation.transitionProperty === 'transform');
				if (!closing) { finish(new Error('Settings has no closing transform transition')); return; }
				for (const animation of animations) animation.pause();
				const frames = [];
				for (const progress of [0, .25, .5, .75, .99]) {
					for (const animation of animations) animation.currentTime = Number(animation.effect.getTiming().duration) * progress;
					frames.push({ inert: background.hasAttribute('inert'), position: new DOMMatrix(getComputedStyle(popup).transform).f });
				}
				const duration = Number(closing.effect.getTiming().duration);
				for (const animation of animations) animation.finish();
				finish(null, { duration, frames });
			}
			observer.observe(popup.ownerDocument.body, { attributes: true, childList: true, subtree: true });
			button.click(); sample();
		});
	});
	expect(result.duration).toBe(320);
	expect(result.frames.every(frame => frame.inert), JSON.stringify(result)).toBe(true);
	expect(result.frames.at(-1).position).toBeGreaterThan(result.frames[0].position);
	expect(result.frames.some(frame => frame.position > result.frames[0].position && frame.position < result.frames.at(-1).position), JSON.stringify(result)).toBe(true);
}
