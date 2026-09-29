import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { requestAdmissionKind } from './admission';

it('admits the paths and explicit methods in each router', () => {
	const sources = ['public.ts', 'sync.ts', 'reminders.ts', 'notifications.ts', 'auth.ts', '../reading/routes.ts', '../router.ts'];
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
