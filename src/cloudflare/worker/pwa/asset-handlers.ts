import { corsHeaders } from '../cors';
import {
	APPLE_TOUCH_ICON_180_PNG,
	CRATE_ICON_192_PNG,
	CRATE_ICON_512_PNG,
	CRATE_MARK_256_PNG,
	ICON_SVG,
	OPEN_OBSIDIAN_HTML,
	OPEN_OBSIDIAN_JS,
	PWA_APP_JS,
	PWA_THEME_BOOTSTRAP_JS,
	SERVICE_WORKER_JS,
	createManifestJson,
	createPwaHtml,
	createPwaVersionJson,
} from '../pwa';
import { PWA_ASSET_VERSION } from '../pwa-version';

function htmlSecurityHeaders(): Record<string, string> {
	return {
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
		'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
		'Content-Security-Policy': [
			"default-src 'none'",
			"style-src 'unsafe-inline'",
			"script-src 'self'",
			"connect-src 'self'",
			"img-src 'self' data:",
			"manifest-src 'self'",
			"base-uri 'none'",
			"form-action 'none'",
			"frame-ancestors 'none'",
		].join('; '),
	};
}

function staticAssetHeaders(): Record<string, string> {
	return {
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
	};
}

function versionedAssetHeaders(request: Request): Record<string, string> {
	const version = new URL(request.url).searchParams.get('v')?.trim();
	return {
		'Cache-Control': version === PWA_ASSET_VERSION
			? 'public, max-age=31536000, immutable'
			: 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
	};
}

export function handleNotificationsPage(request: Request): Response {
	return new Response(createPwaHtml(request.url), {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			...htmlSecurityHeaders(),
			...corsHeaders(),
		},
	});
}

export function handleServiceWorker(): Response {
	return new Response(SERVICE_WORKER_JS, {
		headers: {
			'Content-Type': 'application/javascript',
			'Service-Worker-Allowed': '/notifications',
			...staticAssetHeaders(),
			...corsHeaders(),
		},
	});
}

function javascriptAssetResponse(request: Request, source: string): Response {
	return new Response(source, {
		headers: {
			'Content-Type': 'application/javascript; charset=utf-8',
			...versionedAssetHeaders(request),
			...corsHeaders(),
		},
	});
}

export function handlePwaApp(request: Request): Response {
	return javascriptAssetResponse(request, PWA_APP_JS);
}

export function handlePwaThemeBootstrap(request: Request): Response {
	return javascriptAssetResponse(request, PWA_THEME_BOOTSTRAP_JS);
}

export function handleManifest(request: Request): Response {
	return new Response(createManifestJson(request.url), {
		headers: {
			'Content-Type': 'application/manifest+json',
			...staticAssetHeaders(),
			...corsHeaders(),
		},
	});
}

export function handlePwaVersion(): Response {
	return new Response(createPwaVersionJson(), {
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			...staticAssetHeaders(),
			...corsHeaders(),
		},
	});
}

export function handleOpenObsidian(): Response {
	return new Response(OPEN_OBSIDIAN_HTML, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			...htmlSecurityHeaders(),
		},
	});
}

export function handleOpenObsidianScript(request: Request): Response {
	return javascriptAssetResponse(request, OPEN_OBSIDIAN_JS);
}

export function handleIcon(request: Request): Response {
	return new Response(ICON_SVG, {
		headers: {
			'Content-Type': 'image/svg+xml',
			...versionedAssetHeaders(request),
			...corsHeaders(),
		},
	});
}

function pngAssetResponse(request: Request, asset: Uint8Array): Response {
	return new Response(asset, {
		headers: {
			'Content-Type': 'image/png',
			...versionedAssetHeaders(request),
			...corsHeaders(),
		},
	});
}

export function handleAppleTouchIcon(request: Request): Response {
	return pngAssetResponse(request, APPLE_TOUCH_ICON_180_PNG);
}

export function handleCrateIcon192(request: Request): Response {
	return pngAssetResponse(request, CRATE_ICON_192_PNG);
}

export function handleCrateIcon512(request: Request): Response {
	return pngAssetResponse(request, CRATE_ICON_512_PNG);
}

export function handleCrateMark256(request: Request): Response {
	return pngAssetResponse(request, CRATE_MARK_256_PNG);
}
