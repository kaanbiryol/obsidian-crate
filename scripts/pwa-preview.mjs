import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { previewEnrollmentToken } from './pwa-preview-fixtures.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const port = Number.parseInt(process.env.PORT || '8789', 10);

try {
	const assets = await buildPwaPreviewAssets();
	const { origin } = await listenPwaPreviewServer({ port, assets });
	console.log(`PWA preview running at ${origin}`);
	console.log(`Open ${origin}/notifications?token=${previewEnrollmentToken}&folder=Reminders&upcomingDays=7`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(error && typeof error === 'object' && 'status' in error ? error.status : 1);
}
