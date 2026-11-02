type DeviceNavigator = Pick<Navigator, 'maxTouchPoints' | 'userAgent'>;

export function isIosOrIpados(deviceNavigator: DeviceNavigator = navigator): boolean {
	return /iPad|iPhone|iPod/i.test(deviceNavigator.userAgent)
		|| (/Macintosh/i.test(deviceNavigator.userAgent) && deviceNavigator.maxTouchPoints > 1);
}

export function detectDeviceName(deviceNavigator: DeviceNavigator = navigator): string {
	const ua = deviceNavigator.userAgent;
	if (/iPhone/i.test(ua)) return 'iPhone';
	if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && deviceNavigator.maxTouchPoints > 1)) return 'iPad';
	if (/Android/i.test(ua)) return 'Android';
	if (/Mac/i.test(ua)) return 'Mac';
	if (/Windows/i.test(ua)) return 'Windows';
	return 'Web';
}

export function isStandaloneApp(): boolean {
	return window.matchMedia('(display-mode: standalone)').matches
		|| Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}
