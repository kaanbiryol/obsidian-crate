import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { useReminderEditor } from './useReminderEditor';
import type { ModalState, ReminderRecord } from '../types';

const reminder: ReminderRecord = { id: 'one', content: 'First reminder', completed: false, priority: 4,
	revision: 'original', filePath: 'Reminders/Inbox.md', project: 'Inbox' };

describe('reminder editor presentation', () => {
	it('mounts a new draft synchronously and protects it from an old close callback', () => {
		const setSettingsOpen = vi.fn();
		const rendered = renderHook(() => useReminderEditor(setSettingsOpen));
		act(() => {
			rendered.current.openReminder('edit', reminder, 'Inbox');
			expect(rendered.current.modal).toMatchObject({ reminderId: 'one', expectedRevision: 'original', draft: { content: 'First reminder' } });
		});
		act(() => rendered.current.closeModal());
		expect(rendered.current.transition.isClosing).toBe(true);
		const oldClose = rendered.current.transition.finishClose;
		act(() => rendered.current.openReminder('create', null, 'Work'));
		act(oldClose);
		expect(rendered.current.modal).toMatchObject({ mode: 'create', draft: { project: 'Work' } });
		expect(rendered.current.transition.isClosing).toBe(false);
		expect(setSettingsOpen).toHaveBeenLastCalledWith(false);
	});

	it('preserves failed-operation identity and draft while clearing saving state', () => {
		const rendered = renderHook(() => useReminderEditor(vi.fn()));
		act(() => rendered.current.openReminder('edit', reminder, 'Inbox'));
		const recovered: ModalState = { ...rendered.current.modal!, operationId: 'failed-operation' };
		act(() => rendered.current.setSaving(true));
		act(() => rendered.current.openEditor(recovered));
		expect(rendered.current.modal).toBe(recovered);
		expect(rendered.current.saving).toBe(false);
		act(() => rendered.current.closeModal());
		act(() => rendered.current.transition.finishClose());
		expect(rendered.current.modal).toBeNull();
	});

	it('clears the editor, pending close, and saving state when the session resets', () => {
		const rendered = renderHook(() => useReminderEditor(vi.fn()));
		act(() => rendered.current.openReminder('edit', reminder, 'Inbox'));
		act(() => rendered.current.closeModal());
		act(() => rendered.current.setSaving(true));
		act(() => rendered.current.resetEditor());
		expect(rendered.current.modal).toBeNull();
		expect(rendered.current.saving).toBe(false);
		expect(rendered.current.transition.isClosing).toBe(false);
	});
});
