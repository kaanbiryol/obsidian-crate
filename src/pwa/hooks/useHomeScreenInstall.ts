import { useEffect, useState } from 'react';
import { isIosOrIpados, isStandaloneApp } from '../config';

export type HomeScreenPlatform = 'ios' | 'android';

function getMobilePlatform(): HomeScreenPlatform | null {
	if (isIosOrIpados()) return 'ios';
	if (/Android/i.test(navigator.userAgent)) return 'android';
	return null;
}

export function useHomeScreenInstall() {
	const [platform] = useState(getMobilePlatform);
	const [installed, setInstalled] = useState(isStandaloneApp);

	useEffect(() => {
		if (!platform) return;
		const displayMode = window.matchMedia('(display-mode: standalone)');
		const checkDisplayMode = () => {
			if (isStandaloneApp()) setInstalled(true);
		};
		const handleInstalled = () => {
			setInstalled(true);
		};
		displayMode.addEventListener('change', checkDisplayMode);
		window.addEventListener('appinstalled', handleInstalled);
		return () => {
			displayMode.removeEventListener('change', checkDisplayMode);
			window.removeEventListener('appinstalled', handleInstalled);
		};
	}, [platform]);

	return {
		platform: installed ? null : platform,
	};
}
