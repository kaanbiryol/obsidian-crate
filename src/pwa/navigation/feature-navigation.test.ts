import { expect, it, vi } from 'vitest';
import { createRememberedTabs } from './feature-navigation';

it('notifies docks only when a remembered tab changes', () => {
	const remembered = createRememberedTabs('favorites');
	const changed = vi.fn();
	const unsubscribe = remembered.subscribe(changed);
	expect(remembered.get()).toEqual({ readingTab: 'favorites', reminderDockIndex: null });
	const before = remembered.get();
	remembered.rememberReadingTab('favorites');
	expect(changed).not.toHaveBeenCalled();
	expect(remembered.get()).toBe(before);
	remembered.rememberReadingTab('archived');
	remembered.rememberReminderDockIndex(2);
	remembered.rememberReminderDockIndex(2);
	expect(changed).toHaveBeenCalledTimes(2);
	expect(remembered.get()).toEqual({ readingTab: 'archived', reminderDockIndex: 2 });
	unsubscribe();
	remembered.rememberReadingTab('inbox');
	expect(changed).toHaveBeenCalledTimes(2);
});
