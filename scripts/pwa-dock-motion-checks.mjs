// Drive the production JS spring in fixed frames. Native CSS transitions use a
// separate timeline and must be sampled through Animation.currentTime instead.
export async function captureDockSpring(page) {
	await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
	let recorder;
	try {
		recorder = await page.evaluateHandle(() => {
			const dock = document.querySelector('.crate-feature-panel[data-active="true"] .pwa-dock');
			const surface = dock.querySelector('.pwa-dock__surface');
			const height = () => parseFloat(getComputedStyle(surface).height);
			return {
				open: () => dock.querySelector('[data-dock-group]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
				sample: () => {
					const menu = dock.querySelector('.pwa-dock__menu');
					const box = menu?.getBoundingClientRect();
					return { height: height(), reveal: menu ? {
						edge: box.top + parseFloat(getComputedStyle(dock).getPropertyValue('--dock-menu-inset')),
						surface: surface.getBoundingClientRect().top, top: box.top, height: box.height,
						opacity: Number(getComputedStyle(menu.querySelector('.pwa-dock__choices')).opacity),
						tabOpacity: Number(getComputedStyle(dock.querySelector('.pwa-dock__tab')).opacity),
						indicatorOpacity: Number(getComputedStyle(dock.querySelector('.pwa-dock__indicator')).opacity),
					} : null };
				},
				reverse: async () => {
					const before = height();
					document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
					await Promise.resolve();
					return { before, after: height() };
				},
			};
		});
		await recorder.evaluate(recorder => recorder.open());
		const frames = [];
		for (let time = 0; time < 128; time += 16) {
			await page.clock.runFor(16);
			frames.push(await recorder.evaluate(recorder => recorder.sample()));
		}
		return { samples: frames.map(frame => frame.height), reveals: frames.flatMap(frame => frame.reveal ? [frame.reveal] : []),
			...await recorder.evaluate(recorder => recorder.reverse()) };
	} finally {
		await recorder?.dispose();
		await page.clock.resume();
	}
}
