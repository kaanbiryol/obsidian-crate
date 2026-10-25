import assert from 'node:assert/strict';

// Mirrors src/protocol/encrypted-path.ts: 26 lowercase base32 characters, keeping only `.md`.
const WIRE_SEGMENT = /^[a-z2-7]{26}(\.md)?$/;
export const isWirePath = path => typeof path === 'string' && path.split('/').every(segment => WIRE_SEGMENT.test(segment));

/** Records every request a browser context sends to `origin` whose URL or body names
 * a plaintext file or folder. The fragment never leaves the browser, so it is skipped. */
export function recordPlaintextNames(context, origin, names) {
	const result = { leaks: [], count: 0, stop: () => context.off('request', listener) };
	const listener = request => {
		const url = new URL(request.url());
		if (url.origin !== origin) return;
		url.hash = '';
		let address = url.href.replace(/\+/g, ' ');
		try { address = decodeURIComponent(address); } catch { /* Keep the raw form. */ }
		const body = request.postDataBuffer()?.toString('utf8') ?? '';
		result.count++;
		for (const name of names) if (address.includes(name) || body.includes(name)) result.leaks.push(`${request.method()} ${url.pathname}: ${name}`);
	};
	context.on('request', listener);
	return result;
}

/** The server's database must hold encrypted names only: scan every table. */
export async function assertNoPlaintextNames(db, names) {
	const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()).results;
	assert.ok(tables.some(table => table.name === 'files'));
	for (const { name } of tables) {
		const text = JSON.stringify((await db.prepare(`SELECT * FROM "${name}"`).all()).results);
		for (const plain of names) assert.ok(!text.includes(plain), `The server table ${name} stores the plaintext name ${plain}`);
	}
}
