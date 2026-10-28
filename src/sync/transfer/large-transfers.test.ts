import { afterEach, expect, it } from 'vitest';
import { Platform } from 'obsidian';
import { createLargeTransferGate, MOBILE_LARGE_TRANSFER_BYTES as LARGE } from './large-transfers';

const mobile = Platform.isMobile;
afterEach(() => { Platform.isMobile = mobile; });

/** The most transfers of `sizes` that ran at once through one gate. */
async function overlap(isMobile: boolean, sizes: number[]): Promise<number> {
	Platform.isMobile = isMobile;
	const gate = createLargeTransferGate();
	let active = 0, most = 0;
	await Promise.all(sizes.map(size => gate(size, async () => {
		most = Math.max(most, ++active);
		await new Promise(resolve => setTimeout(resolve, 5));
		active--;
	})));
	return most;
}

it('runs large transfers one at a time on mobile without holding back smaller ones', async () => {
	expect(await overlap(true, [LARGE, LARGE * 3, LARGE])).toBe(1);
	expect(await overlap(true, [LARGE, LARGE - 1, LARGE - 1])).toBe(3);
	expect(await overlap(false, [LARGE, LARGE])).toBe(2);
});

it('starts the next large transfer after one fails', async () => {
	Platform.isMobile = true;
	const gate = createLargeTransferGate();
	await expect(gate(LARGE, () => Promise.reject(new Error('lost')))).rejects.toThrow('lost');
	await expect(gate(LARGE, () => Promise.resolve('next'))).resolves.toBe('next');
});
