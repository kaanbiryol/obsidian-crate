import { expect, it } from 'vitest';
import { responseError } from './response-error';

it.each([
	['a Crate error', Response.json({ error: 'Invalid or expired enrollment token', code: 'expired' }, { status: 401 }), { message: 'Invalid or expired enrollment token', code: 'expired' }],
	['a gateway page', new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } }), { message: 'Try again.' }],
	['plain text', new Response('upstream connect error', { status: 503 }), { message: 'Try again.' }],
	['JSON without a message', Response.json({ error: '', code: 7 }, { status: 500 }), { message: 'Try again.' }],
])('turns %s into a short message', async (_name, response, expected) => {
	expect(await responseError(response, 'Try again.')).toEqual(expected);
});
