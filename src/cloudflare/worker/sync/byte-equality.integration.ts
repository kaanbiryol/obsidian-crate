import { expect, it } from 'vitest';

it('compares actual bytes across workerd response buffers, including nested assertions', async () => {
	const bytes = new Uint8Array([1, 2, 3]).buffer;
	const received = await new Response(bytes).arrayBuffer();
	expect(received).toEqual(bytes);
	expect(() => expect({ saved: received }).toEqual({ saved: new Uint8Array([1, 9, 3]).buffer })).toThrow();
	expect(() => expect([received]).toContainEqual(new Uint8Array([1, 2]).buffer)).toThrow();
});
