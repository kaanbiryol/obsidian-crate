import { useCallback, useEffect, useState } from 'react';
import { isIosOrIpados, isStandaloneApp } from '../config';

const DISMISSED_KEY = 'crate-home-screen-prompt-dismissed';

export type HomeScreenPlatform = 'ios' | 'android';

function getMobilePlatform(): HomeScreenPlatform | null {
	if (isIosOrIpados()) return 'ios';
	if (/Android/i.test(navigator.userAgent)) return 'android';
	return null;
}

export function useHomeScreenInstall() {
	const [platform] = useState(getMobilePlatform);
	const [installed, setInstalled] = useState(isStandaloneApp);
	const [dismissed, setDismissed] = useState(() => {
		try {
			return localStorage.getItem(DISMISSED_KEY) === 'true';
		} catch {
			return false;
		}
	});

	const dismiss = useCallback(() => {
		setDismissed(true);
		try {
			localStorage.setItem(DISMISSED_KEY, 'true');
		} catch {
			// Still dismiss for this visit when browser storage is unavailable.
		}
	}, []);

	useEffect(() => {
		if (!platform) return;
		const displayMode = window.matchMedia('(display-mode: standalone)');
		const checkDisplayMode = () => {
			if (isStandaloneApp()) setInstalled(true);
		};
		const handleInstalled = () => {
			setInstalled(true);
			dismiss();
		};
		displayMode.addEventListener('change', checkDisplayMode);
		window.addEventListener('appinstalled', handleInstalled);
		return () => {
			displayMode.removeEventListener('change', checkDisplayMode);
			window.removeEventListener('appinstalled', handleInstalled);
		};
	}, [dismiss, platform]);

	return {
		platform: installed ? null : platform,
		showPrompt: Boolean(platform && !installed && !dismissed),
		dismiss,
	};
}
