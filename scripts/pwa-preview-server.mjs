import http from 'node:http';
import { withPreviewAction } from './pwa-preview-action.mjs';
import {
	createInitialState,
	findReminder,
	normalizeProject,
	parseMutationReminder,
	previewAuthToken,
	previewEnrollmentToken,
	projectNames,
	sortForList,
} from './pwa-preview-fixtures.mjs';
import { readJson, send, sendJson, sendText } from './pwa-preview-http.mjs';

function isAuthorized(req) {
	return req.headers.authorization === `Bearer ${previewAuthToken}`;
}

export function createPwaPreviewServer({ assets, origin }) {
	let state = createInitialState();
	let forcePreviewUpdate = false;
	let previewLoadingUntil = 0;

	const {
		APPLE_TOUCH_ICON_180_PNG,
		CRATE_ICON_192_PNG,
		CRATE_ICON_512_PNG,
		CRATE_MARK_256_PNG,
		PWA_APP_JS,
		PWA_CLIENT_ASSETS,
		PWA_THEME_BOOTSTRAP_JS,
		OPEN_OBSIDIAN_HTML,
		OPEN_OBSIDIAN_JS,
		SERVICE_WORKER_JS,
		ICON_SVG,
		createManifestJson,
		createPwaHtml,
		createPwaVersionJson,
	} = assets;

	return http.createServer(async (req, res) => {
		const url = new URL(req.url || '/', origin);
		const path = url.pathname;
		const method = req.method || 'GET';

		if (method === 'GET' && path === '/') {
			const location = `/notifications?token=${previewEnrollmentToken}&folder=Reminders&upcomingDays=7`;
			send(res, 302, '', { Location: location });
			return;
		}

		if (method === 'POST' && path === '/preview/reset') {
			state = createInitialState();
			sendJson(res, 200, { success: true });
			return;
		}

		if (method === 'GET' && path === '/notifications') {
			const action = url.searchParams.get('previewAction');
			const project = url.searchParams.get('previewProject');
			forcePreviewUpdate = action === 'update' || url.searchParams.get('previewUpdate') === '1';
			if (action === 'loading') previewLoadingUntil = Date.now() + 5_000;
			else if (action) previewLoadingUntil = 0;
			// Home Screen apps have their own storage and may launch without the
			// enrollment query that Safari already removed. Seed only this local
			// fixture session before the real client bootstraps.
			const html = createPwaHtml(url.toString()).replace('</head>', '<script src="/notifications/preview-session.js"></script></head>');
			sendText(res, 200, withPreviewAction(html, action, project), 'text/html; charset=utf-8');
			return;
		}

		if (method === 'GET' && path === '/notifications/preview-session.js') {
			sendText(res, 200, `localStorage.setItem('crate-reminders-auth-token', ${JSON.stringify(previewAuthToken)});`, 'application/javascript; charset=utf-8');
			return;
		}

		if (method === 'GET' && path === '/notifications/app.js') {
			sendText(res, 200, PWA_APP_JS, 'application/javascript; charset=utf-8');
			return;
		}

		if (method === 'GET' && path.startsWith('/notifications/assets/')) {
			const fileName = path.slice('/notifications/assets/'.length);
			const source = PWA_CLIENT_ASSETS[fileName];
			if (typeof source === 'string') {
				sendText(res, 200, source, 'application/javascript; charset=utf-8');
			} else {
				sendJson(res, 404, { error: 'Not found' });
			}
			return;
		}

		if (method === 'GET' && path === '/notifications/theme-bootstrap.js') {
			sendText(res, 200, PWA_THEME_BOOTSTRAP_JS, 'application/javascript; charset=utf-8');
			return;
		}

		if (method === 'GET' && path === '/notifications/sw.js') {
			// Refresh existing preview installations to include the fixture bootstrap.
			const previewWorker = SERVICE_WORKER_JS.replaceAll('crate-reminders-shell-', 'crate-reminders-shell-preview-session-v1-');
			sendText(res, 200, previewWorker, 'application/javascript; charset=utf-8', {
				'Service-Worker-Allowed': '/notifications',
			});
			return;
		}

		if (method === 'GET' && path === '/notifications/open-obsidian') {
			sendText(res, 200, OPEN_OBSIDIAN_HTML, 'text/html; charset=utf-8');
			return;
		}

		if (method === 'GET' && path === '/notifications/open-obsidian.js') {
			sendText(res, 200, OPEN_OBSIDIAN_JS, 'application/javascript; charset=utf-8');
			return;
		}

		if (method === 'GET' && path === '/notifications/manifest.json') {
			sendText(res, 200, createManifestJson(url.toString()), 'application/manifest+json; charset=utf-8');
			return;
		}

		if (method === 'GET' && path === '/notifications/version.json') {
			const version = JSON.parse(createPwaVersionJson()).assetVersion;
			const body = forcePreviewUpdate
				? JSON.stringify({ assetVersion: `${version}-preview` })
				: createPwaVersionJson();
			sendText(res, 200, body, 'application/json; charset=utf-8');
			return;
		}

		if (method === 'GET' && path === '/notifications/icon.svg') {
			sendText(res, 200, ICON_SVG, 'image/svg+xml; charset=utf-8');
			return;
		}

		if (method === 'GET' && path === '/notifications/apple-touch-icon-180.png') {
			send(res, 200, APPLE_TOUCH_ICON_180_PNG, { 'Content-Type': 'image/png' });
			return;
		}

		if (method === 'GET' && path === '/notifications/crate-icon-192.png') {
			send(res, 200, CRATE_ICON_192_PNG, { 'Content-Type': 'image/png' });
			return;
		}

		if (method === 'GET' && path === '/notifications/crate-icon-512.png') {
			send(res, 200, CRATE_ICON_512_PNG, { 'Content-Type': 'image/png' });
			return;
		}

		if (method === 'GET' && path === '/notifications/crate-mark-256.png') {
			send(res, 200, CRATE_MARK_256_PNG, { 'Content-Type': 'image/png' });
			return;
		}

		if (method === 'GET' && path === '/notifications/vapid-public-key') {
			sendJson(res, 200, { publicKey: '' });
			return;
		}

		if (method === 'GET' && path === '/health') {
			const delay = Math.max(0, previewLoadingUntil - Date.now());
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
			sendJson(res, 200, { ok: true });
			return;
		}

		if (method === 'POST' && path === '/notifications/reminders-exchange') {
			const body = await readJson(req).catch(() => null);
			if (!body || !String(body.token || '').trim()) {
				sendJson(res, 401, { error: 'Invalid or expired enrollment token' });
				return;
			}

			sendJson(res, 200, { authToken: previewAuthToken });
			return;
		}

		if (method === 'POST' && path === '/notifications/reminders-enrollment-token') {
			if (!isAuthorized(req)) {
				sendJson(res, 401, { error: 'Unauthorized' });
				return;
			}

			sendJson(res, 200, {
				token: previewEnrollmentToken,
				expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
			});
			return;
		}

		if (method === 'POST' && path === '/notifications/subscribe') {
			if (!isAuthorized(req)) {
				sendJson(res, 401, { error: 'Unauthorized' });
				return;
			}

			sendJson(res, 200, { id: 'preview-subscription' });
			return;
		}

		if (path.startsWith('/reminders/')) {
			if (!isAuthorized(req)) {
				sendJson(res, 401, { error: 'Unauthorized' });
				return;
			}

			if (method === 'GET' && path === '/reminders/list') {
				sendJson(res, 200, {
					reminders: sortForList(state.reminders),
					projects: projectNames(state.reminders),
				});
				return;
			}

			if (method === 'POST' && path === '/reminders/create') {
				const body = await readJson(req);
				const reminder = parseMutationReminder(body);
				state.reminders.push(reminder);
				sendJson(res, 200, { success: true, reminder });
				return;
			}

			if (method === 'POST' && path === '/reminders/update') {
				const body = await readJson(req);
				const current = findReminder(state, String(body.id || ''));
				if (!current) {
					sendJson(res, 404, { error: 'Reminder not found' });
					return;
				}

				Object.assign(current, parseMutationReminder({
					...current,
					...body,
					id: current.id,
					completed: current.completed,
				}));

				sendJson(res, 200, { success: true, reminder: current });
				return;
			}

			if (method === 'POST' && path === '/reminders/set-completed') {
				const body = await readJson(req);
				const current = findReminder(state, String(body.id || ''));
				if (!current) {
					sendJson(res, 404, { error: 'Reminder not found' });
					return;
				}

				current.completed = Boolean(body.completed);
				sendJson(res, 200, { success: true, reminder: current });
				return;
			}

			if (method === 'DELETE' && path === '/reminders/delete') {
				const body = await readJson(req);
				state.reminders = state.reminders.filter((reminder) => reminder.id !== String(body.id || ''));
				sendJson(res, 200, { success: true });
				return;
			}

			if (method === 'POST' && path === '/reminders/reorder') {
				const body = await readJson(req);
				const project = normalizeProject(body.project);
				const orderedIds = Array.isArray(body.orderedIds)
					? body.orderedIds.map((value) => String(value))
					: [];
				const activeReminders = state.reminders.filter((reminder) => reminder.project === project && !reminder.completed);
				const byId = new Map(activeReminders.map((reminder) => [reminder.id, reminder]));
				const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
				if (reordered.length === activeReminders.length) {
					let nextIndex = 0;
					state.reminders = state.reminders.map((reminder) => {
						if (reminder.project === project && !reminder.completed) {
							return reordered[nextIndex++] || reminder;
						}
						return reminder;
					});
				}

				sendJson(res, 200, { success: true });
				return;
			}
		}

		sendJson(res, 404, { error: 'Not found' });
	});
}

export async function listenPwaPreviewServer({ port, assets }) {
	const origin = `http://127.0.0.1:${port}`;
	const server = createPwaPreviewServer({ assets, origin });
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	return { server, origin };
}
