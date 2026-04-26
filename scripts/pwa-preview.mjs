import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createJiti } from 'jiti';

const port = Number.parseInt(process.env.PORT || '8789', 10);
const origin = `http://127.0.0.1:${port}`;
const previewAuthToken = 'preview-auth-token';
const previewEnrollmentToken = 'preview-install-token';

const buildResult = spawnSync(process.execPath, ['scripts/build-worker.mjs'], {
	cwd: process.cwd(),
	stdio: 'inherit',
});

if (buildResult.status !== 0) {
	process.exit(buildResult.status ?? 1);
}

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
	PWA_APP_JS,
	SERVICE_WORKER_JS,
	ICON_SVG,
	createManifestJson,
	createPwaHtml,
} = await jiti.import('../src/cloudflare/worker/pwa.ts');

function daysFromNow(days, hour = 9, minute = 0) {
	const next = new Date();
	next.setHours(hour, minute, 0, 0);
	next.setDate(next.getDate() + days);
	return next.toISOString();
}

function createInitialState() {
	return {
		reminders: [
			{
				id: 'preview-inbox-1',
				content: 'Check this article',
				description: '',
				dueDate: undefined,
				dueDatetime: undefined,
				priority: 4,
				completed: false,
				project: 'Inbox',
				filePath: 'Reminders/Inbox.md',
			},
			{
				id: 'preview-inbox-2',
				content: 'Tighten the PWA layout',
				description: 'Reduce vertical chrome, fix card spacing, and make the sheet feel native on iPhone.',
				dueDate: undefined,
				dueDatetime: undefined,
				priority: 4,
				completed: false,
				project: 'Inbox',
				filePath: 'Reminders/Inbox.md',
			},
			{
				id: 'preview-work-1',
				content: 'Do I have this documented already?',
				description: 'Reducing project generation time was called out as a major issue in the last review.',
				dueDate: undefined,
				dueDatetime: daysFromNow(-1, 10, 30),
				priority: 4,
				completed: false,
				project: 'Work',
				filePath: 'Reminders/Work.md',
			},
			{
				id: 'preview-work-2',
				content: "Fix your ADR's Bazel section",
				description: 'Pull a few CI numbers so the note has a concrete performance comparison.',
				dueDate: undefined,
				dueDatetime: daysFromNow(0, 12, 0),
				priority: 4,
				completed: false,
				project: 'Work',
				filePath: 'Reminders/Work.md',
			},
			{
				id: 'preview-personal-1',
				content: 'Call the dentist',
				description: '',
				dueDate: undefined,
				dueDatetime: daysFromNow(2, 15, 0),
				priority: 4,
				completed: false,
				project: 'Personal',
				filePath: 'Reminders/Personal.md',
			},
			{
				id: 'preview-work-3',
				content: 'Archive old reminder copy',
				description: 'Completed items should stay below active ones.',
				dueDate: undefined,
				dueDatetime: daysFromNow(-2, 8, 0),
				priority: 4,
				completed: true,
				project: 'Work',
				filePath: 'Reminders/Work.md',
			},
		],
	};
}

let state = createInitialState();

function withPreviewAction(html, action, project) {
	if (!action) {
		return html;
	}

	const escapedProject = JSON.stringify(project || '');
	const escapedAction = JSON.stringify(action);
	const script = `
<script>
window.addEventListener('load', () => {
	const action = ${escapedAction};
	const project = ${escapedProject};
	const click = (selector) => {
		const el = document.querySelector(selector);
		if (el) el.click();
	};
	const openProject = () => {
		const buttons = Array.from(document.querySelectorAll('[data-action="open-project"]'));
		const match = buttons.find((button) => button.getAttribute('data-project') === project);
		if (match) match.click();
	};
	const openFirstReminder = () => {
		const card = document.querySelector('.premium-reminder-card');
		if (card) card.click();
	};
	const run = () => {
		switch (action) {
			case 'create':
				click('[data-action="open-create-modal"]');
				break;
			case 'edit':
				openFirstReminder();
				break;
			case 'edit-today':
				click('[data-action="switch-tab"][data-tab="today"]');
				setTimeout(openFirstReminder, 160);
				break;
			case 'settings':
				click('[data-action="toggle-settings"]');
				break;
			case 'today':
			case 'upcoming':
			case 'projects':
				click('[data-action="switch-tab"][data-tab="' + action + '"]');
				break;
			case 'project':
				click('[data-action="switch-tab"][data-tab="projects"]');
				setTimeout(openProject, 120);
				break;
		}
	};
	setTimeout(run, 120);
	setTimeout(run, 480);
});
</script>`;

	return html.replace('</body>', `${script}</body>`);
}

function send(res, statusCode, body, headers = {}) {
	res.writeHead(statusCode, {
		'Cache-Control': 'no-store',
		...headers,
	});
	res.end(body);
}

function sendJson(res, statusCode, payload) {
	send(res, statusCode, JSON.stringify(payload), {
		'Content-Type': 'application/json; charset=utf-8',
	});
}

function sendText(res, statusCode, body, contentType) {
	send(res, statusCode, body, {
		'Content-Type': contentType,
	});
}

async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	if (chunks.length === 0) {
		return {};
	}

	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isAuthorized(req) {
	return req.headers.authorization === `Bearer ${previewAuthToken}`;
}

function normalizeProject(project) {
	const trimmed = String(project || '').trim();
	return trimmed || 'Inbox';
}

function applyProjectFilePath(reminder) {
	return {
		...reminder,
		project: normalizeProject(reminder.project),
		filePath: `Reminders/${normalizeProject(reminder.project)}.md`,
	};
}

function sortForList(reminders) {
	return reminders.map(applyProjectFilePath);
}

function projectNames() {
	return Array.from(new Set(state.reminders.map((reminder) => normalizeProject(reminder.project)))).sort((a, b) => a.localeCompare(b));
}

function findReminder(id) {
	return state.reminders.find((reminder) => reminder.id === id);
}

function parseMutationReminder(body) {
	const project = normalizeProject(body.project);
	return applyProjectFilePath({
		id: body.id || randomUUID(),
		content: String(body.content || '').trim(),
		description: body.description ? String(body.description) : '',
		dueDate: body.dueDate || undefined,
		dueDatetime: body.dueDatetime || undefined,
		priority: Number.parseInt(String(body.priority || '4'), 10) === 1 ? 1 : 4,
		completed: Boolean(body.completed),
		project,
		filePath: `Reminders/${project}.md`,
	});
}

const server = http.createServer(async (req, res) => {
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
		sendText(res, 200, withPreviewAction(createPwaHtml(url.toString()), action, project), 'text/html; charset=utf-8');
		return;
	}

	if (method === 'GET' && path === '/notifications/app.js') {
		sendText(res, 200, PWA_APP_JS, 'application/javascript; charset=utf-8');
		return;
	}

	if (method === 'GET' && path === '/notifications/sw.js') {
		sendText(res, 200, SERVICE_WORKER_JS, 'application/javascript; charset=utf-8');
		return;
	}

	if (method === 'GET' && path === '/notifications/manifest.json') {
		sendText(res, 200, createManifestJson(url.toString()), 'application/manifest+json; charset=utf-8');
		return;
	}

	if (method === 'GET' && path === '/notifications/icon.svg') {
		sendText(res, 200, ICON_SVG, 'image/svg+xml; charset=utf-8');
		return;
	}

	if (method === 'GET' && path === '/notifications/vapid-public-key') {
		sendJson(res, 200, { publicKey: '' });
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
				projects: projectNames(),
			});
			return;
		}

		if (method === 'POST' && path === '/reminders/create') {
			const body = await readJson(req);
			const reminder = parseMutationReminder(body);
			state.reminders.push(reminder);
			sendJson(res, 200, reminder);
			return;
		}

		if (method === 'POST' && path === '/reminders/update') {
			const body = await readJson(req);
			const current = findReminder(String(body.id || ''));
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

			sendJson(res, 200, current);
			return;
		}

		if (method === 'POST' && path === '/reminders/set-completed') {
			const body = await readJson(req);
			const current = findReminder(String(body.id || ''));
			if (!current) {
				sendJson(res, 404, { error: 'Reminder not found' });
				return;
			}

			current.completed = Boolean(body.completed);
			sendJson(res, 200, current);
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

server.listen(port, '127.0.0.1', () => {
	console.log(`PWA preview running at ${origin}`);
	console.log(`Open ${origin}/notifications?token=${previewEnrollmentToken}&folder=Reminders&upcomingDays=7`);
});
