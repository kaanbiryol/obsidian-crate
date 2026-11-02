import { manifestHrefForUrl } from '../shell/pwa-params';
import { isStandaloneApp } from '../shell/device';
import { clearInstallEnrollment } from './install-enrollment';

export function urlWithoutEnrollmentTokens({
	pathname,
	search,
	hash,
}: Pick<Location, 'pathname' | 'search' | 'hash'>, preserveInstallToken = false): string {
	const params = new URLSearchParams(search);
	if (!preserveInstallToken) params.delete('token');
	params.delete('browserToken');
	const nextSearch = params.toString();
	return `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash}`;
}

export function finishEnrollment(preserveInstallToken = !isStandaloneApp()): void {
	if (!preserveInstallToken) clearInstallEnrollment();
	const params = new URLSearchParams(window.location.search);
	if (!params.has('token') && !params.has('browserToken')) return;
	// Keep Safari's install grant in the document URL as well as the manifest:
	// Add to Home Screen may use the document URL, and reloads must retain it.
	const nextUrl = urlWithoutEnrollmentTokens(window.location, preserveInstallToken);
	const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
	if (nextUrl !== currentUrl) {
		window.history.replaceState(window.history.state, '', nextUrl);
	}
	const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
	if (manifest) manifest.href = manifestHrefForUrl(window.location.href);
}

export function enrollmentTokenFromParams(
	params: URLSearchParams,
	standalone = isStandaloneApp(),
): string | null {
	const installToken = params.get('token')?.trim() || null;
	const browserToken = params.get('browserToken')?.trim() || null;
	return standalone
		? installToken
		: browserToken;
}
