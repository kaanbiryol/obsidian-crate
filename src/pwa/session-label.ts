import { detectDeviceName, isIosOrIpados, isStandaloneApp } from './config';

type DeviceNavigator = Pick<Navigator, 'userAgent' | 'maxTouchPoints'>;

function browserLabel(userAgent: string): string {
	// Browser tokens overlap (Chrome includes Safari; Edge includes Chrome).
	// This is a display label only, never feature or authentication detection.
	if (/(?:Edg|Edge|EdgiOS|EdgA)\//i.test(userAgent)) return 'Edge';
	if (/(?:OPR|OPiOS)\//i.test(userAgent)) return 'Opera';
	if (/(?:Firefox|FxiOS)\//i.test(userAgent)) return 'Firefox';
	if (/(?:Chrome|CriOS|Chromium)\//i.test(userAgent)) return 'Chrome';
	if (/Version\/[\d.]+.*Safari\//i.test(userAgent)) return 'Safari';
	return 'Browser';
}

export function detectWebSessionName(
	deviceNavigator: DeviceNavigator = navigator,
	standalone = isStandaloneApp(),
): string {
	const mobile = isIosOrIpados(deviceNavigator) || /Android/i.test(deviceNavigator.userAgent);
	const client = standalone
		? mobile ? 'Home Screen app' : 'Installed app'
		: browserLabel(deviceNavigator.userAgent);
	return `${detectDeviceName(deviceNavigator)} · ${client}`;
}
