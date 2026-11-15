import { expect, it } from 'vitest';
import { isReceiptEnvelope, MAX_ENCRYPTED_REMINDER_ACK } from './receipt-format';

it('recognizes only bounded compact receipt envelopes', () => {
	expect(isReceiptEnvelope('aa.bb.cc.dd.ee')).toBe(true);
	expect(isReceiptEnvelope('a.b.c.d')).toBe(false);
	expect(isReceiptEnvelope('a.b.c.d.e=')).toBe(false);
	expect(isReceiptEnvelope('{"ok":true}')).toBe(false);
	expect(isReceiptEnvelope(5)).toBe(false);
	expect(isReceiptEnvelope('a.b.c.d.' + 'e'.repeat(MAX_ENCRYPTED_REMINDER_ACK))).toBe(false);
});
