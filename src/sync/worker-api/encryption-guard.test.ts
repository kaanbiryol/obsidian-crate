import { describe, expect, it, vi } from 'vitest';
import { EncryptionDowngradeGuard } from './encryption-guard';

describe('EncryptionDowngradeGuard', () => {
	it('probes private mutations without keys until a recent response says encryption is off', () => {
		const guard = new EncryptionDowngradeGuard();
		expect(guard.mutationNeedsProbe('/sync/upload?path=a.md', true, false, 0)).toBe(true);
		expect(guard.mutationNeedsProbe('/settings', true, false, 0)).toBe(true);
		expect(guard.mutationNeedsProbe('/devices/rename', true, false, 0)).toBe(false);
		expect(guard.mutationNeedsProbe('/sync/upload', true, true, 0)).toBe(false);
		expect(guard.mutationNeedsProbe('/sync/upload', false, false, 0)).toBe(false);

		guard.observe('off', 200, guard.dispatched(1_000));
		expect(guard.mutationNeedsProbe('/sync/upload', true, false, 30_999)).toBe(false);
		expect(guard.mutationNeedsProbe('/sync/upload', true, false, 31_000)).toBe(true);
	});

	it('drops the unencrypted verdict on refusals and ignores responses dispatched before that', () => {
		const guard = new EncryptionDowngradeGuard();
		const early = guard.dispatched(0);
		guard.observe(null, 423, guard.dispatched(0));
		guard.observe('off', 200, early);
		expect(guard.mutationNeedsProbe('/sync/upload', true, false, 1)).toBe(true);

		guard.observe('off', 200, guard.dispatched(0));
		guard.observe(null, 401, guard.dispatched(0));
		expect(guard.mutationNeedsProbe('/sync/upload', true, false, 1)).toBe(true);
	});

	it('reports an encrypted response and never trusts an unencrypted one while plaintext is refused', () => {
		const guard = new EncryptionDowngradeGuard();
		const onEncrypted = vi.fn();
		guard.observeEncryption(onEncrypted);
		guard.observe('on', 200, guard.dispatched(0));
		expect(onEncrypted).toHaveBeenCalledOnce();

		guard.refusePlaintext(true);
		guard.observe('off', 200, guard.dispatched(0));
		expect(guard.mutationNeedsProbe('/sync/upload', false, false, 1)).toBe(true);
		expect(guard.readNeedsProbe('/sync/metadata', 'POST', false)).toBe(true);
		expect(guard.readNeedsProbe('/sync/file?path=a.md', 'GET', false)).toBe(true);
		expect(guard.readNeedsProbe('/sync/manifest', 'GET', false)).toBe(false);
		expect(guard.readNeedsProbe('/sync/metadata', 'POST', true)).toBe(false);
		guard.refusePlaintext(false);
		expect(guard.readNeedsProbe('/sync/metadata', 'POST', false)).toBe(false);
	});
});
