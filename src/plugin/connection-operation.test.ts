import { expect, it } from 'vitest';
import { beginConnectionOperation, runningConnectionOperation } from './connection-operation';

it('lets one connection flow run at a time for each plugin', () => {
	const plugin = {} as never, other = {} as never;
	const release = beginConnectionOperation(plugin, 'self-hosted')!;
	expect(runningConnectionOperation(plugin)).toBe('self-hosted');
	expect(beginConnectionOperation(plugin, 'pairing')).toBeNull();
	expect(beginConnectionOperation(plugin, 'cloudflare')).toBeNull();
	// Another plugin instance, as after a reload, has its own slot.
	expect(beginConnectionOperation(other, 'pairing')).not.toBeNull();
	release();
	expect(runningConnectionOperation(plugin)).toBeUndefined();
	expect(beginConnectionOperation(plugin, 'cloudflare')).not.toBeNull();
});
