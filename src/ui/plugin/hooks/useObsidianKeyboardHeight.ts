import { useEffect, useState } from 'react';

export function parseKeyboardHeight(value: string): number {
	const height = Number.parseFloat(value);
	return Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
}

/** Reads the keyboard overlap Obsidian mobile publishes for its own layout. */
function readObsidianKeyboardHeight(root: HTMLElement): number {
	return parseKeyboardHeight(getComputedStyle(root).getPropertyValue('--keyboard-height'));
}

/**
 * Obsidian mobile owns the native keyboard and sets --keyboard-height on the
 * document root. Measuring the viewport instead can count the keyboard twice
 * when Android resizes the webview.
 */
export function useObsidianKeyboardHeight(enabled: boolean = true): number {
	const [height, setHeight] = useState(0);

	useEffect(() => {
		if (!enabled) {
			setHeight(0);
			return;
		}
		const root = document.documentElement;
		let animationFrame: number | null = null;
		const update = () => {
			if (animationFrame !== null) return;
			animationFrame = window.requestAnimationFrame(() => {
				animationFrame = null;
				setHeight(readObsidianKeyboardHeight(root));
			});
		};
		setHeight(readObsidianKeyboardHeight(root));
		const observer = new MutationObserver(update);
		observer.observe(root, { attributes: true, attributeFilter: ['style', 'class'] });
		window.addEventListener('resize', update);
		window.visualViewport?.addEventListener('resize', update);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', update);
			window.visualViewport?.removeEventListener('resize', update);
			if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
		};
	}, [enabled]);

	return enabled ? height : 0;
}
