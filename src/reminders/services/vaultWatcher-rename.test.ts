import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReminderByteVault } from '@/test/factories/reminder-byte-vault';
import { createReminderIndex } from '../data/reminder-index';
import { VaultWatcher } from './vaultWatcher';

const fixtures: Awaited<ReturnType<typeof createReminderByteVault>>[] = [];
afterEach(async () => {
	vi.useRealTimers(); vi.unstubAllGlobals();
	for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe('reminder edit and rename events', () => {
	it.each([1, 3])('rescans the latest title, schedule and path after %i renames during debounce', async renames => {
		vi.useFakeTimers(); vi.stubGlobal('window', { setTimeout, clearTimeout });
		const initial = 'Reminders/Original.md';
		const h = await createReminderByteVault({ [initial]: '- [ ] Original title <!-- crate-id:one -->\n' });
		fixtures.push(h);
		const handlers = new Map<string, (...args: never[]) => void>();
		Object.assign(h.app.vault, { on: (name: string, callback: (...args: never[]) => void) => { handlers.set(name, callback); return {}; }, offref: vi.fn() });
		const index = createReminderIndex(h.app, 'Reminders');
		await index.load();
		const rescan = vi.spyOn(index, 'rescanFile');
		const watcher = new VaultWatcher({ app: h.app } as never, index);
		watcher.register();
		const file = await h.put(initial, '- [ ] Edited title Jan 12, 2027 <!-- crate-id:one -->\n');
		handlers.get('modify')!(file as never);
		for (let i = 0; i < renames; i++) {
			const oldPath = file.path;
			await h.vault.adapter.rename(oldPath, `Reminders/After-${i}.md`);
			handlers.get('rename')!(file as never, oldPath as never);
		}
		await vi.advanceTimersByTimeAsync(1500);
		expect(rescan).toHaveBeenCalledOnce();
		await rescan.mock.results[0]!.value;
		expect(index.getById('one')).toMatchObject({ content: 'Edited title', dueDate: '2027-01-12', filePath: `Reminders/After-${renames - 1}.md` });
		expect(index.getByFile(initial)).toEqual([]);
		watcher.unregister();
	});
});
