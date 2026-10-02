import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { requestAdmissionKind } from './admission';

it('admits the paths and explicit methods in each router', () => {
	const sources = ['public.ts', 'sync.ts', 'reminders.ts', 'notifications.ts', 'auth.ts', '../reading/routes.ts', '../router.ts', 'encryption.ts', '../encryption-conversion.ts', '../encryption-reset.ts', '../encrypted-reminders.ts'];
	for (const source of sources) {
		const text = readFileSync(new URL(source, import.meta.url), 'utf8');
		for (const line of text.split('\n')) {
			if (!line.trimStart().startsWith('if (')) continue;
			const path = /path === '(\/[^']*)'/u.exec(line)?.[1];
			if (!path) continue;
			const methods = [...line.matchAll(/(?:method === |\[|, )'(GET|POST|PUT|DELETE)'/gu)].map(match => match[1]!);
			if (!methods.length) {
				expect(['GET', 'POST', 'PUT', 'DELETE'].some(method => requestAdmissionKind(new Request(`https://test${path}`, { method })) !== 'unknown'), `${source}: ${path}`).toBe(true);
			} else for (const method of methods) expect(requestAdmissionKind(new Request(`https://test${path}`, { method })), `${source}: ${method} ${path}`).not.toBe('unknown');
		}
	}
});

// These handlers dispatch methods in nested branches, beyond the source inventory above.
it('admits encryption control-plane and scoped reminder operations', () => {
	const routes = [
		'GET /encryption', 'POST /encryption/metadata', 'GET /encryption/folders',
		'GET /encryption/upload-receipt', 'GET /encryption/deletion-precondition',
		'GET /encryption/reset', 'POST /encryption/reset',
		'GET /encryption/conversion', 'POST /encryption/conversion',
		'GET /encryption/conversion/file', 'PUT /encryption/conversion/file',
		'GET /encryption/conversion/settings', 'PUT /encryption/conversion/settings',
		'PUT /encryption/conversion/receipt', 'GET /encryption/conversion/checkpoints',
		'PUT /encryption/conversion/checkpoint', 'POST /encryption/conversion/finish',
		'GET /reminders/encrypted-files', 'GET /reminders/encrypted-file',
		'GET /reminders/encrypted-receipt', 'POST /reminders/encrypted-commit',
	];
	for (const route of routes) {
		const [method, path] = route.split(' ');
		expect(requestAdmissionKind(new Request(`https://test${path}`, { method })), route).toBe('api');
	}
});
