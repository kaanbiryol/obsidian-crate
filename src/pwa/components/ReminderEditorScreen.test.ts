import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReminderEditorScreen } from './ReminderEditorScreen';
import type { ModalState } from '../types';
import { ModalHeader } from '@/ui/shared/ModalHeader';

function renderEditor(overrides: Partial<React.ComponentProps<typeof ReminderEditorScreen>> = {}) {
	const modal: ModalState = {
		mode: 'edit',
		reminderId: 'preview-reminder',
		draft: {
			content: 'Buy milk', description: 'Two cartons', project: 'Inbox', defaultProject: 'Inbox',
			priority: 4, dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false,
		},
	};
	return renderToStaticMarkup(React.createElement(ReminderEditorScreen, {
		modal, colorScheme: 'dark', projectOptions: ['Inbox', 'Work'],
		saving: false, isClosing: false, isActive: true, isReturningToEditor: false,
		canInteract: true, editorFocusRequest: 0,
		dialogRef: vi.fn(), onPatchDraft: vi.fn(), onOpenPicker: vi.fn(),
		onClose: vi.fn(), onSave: vi.fn(), onDelete: vi.fn(),
		...overrides,
	}));
}

function button(markup: string, action: string) {
	const tag = markup.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))?.[0];
	expect(tag).toBeDefined();
	return tag!;
}

describe('PWA shared editor integration', () => {
	it('uses the same close icon as the plugin header', () => {
		const editor = renderEditor();
		expect(editor).toContain('aria-label="Close reminder editor"');
		expect(editor).toContain('title="Close"');
		expect(editor).not.toContain('>Cancel</button>');
		const pluginHeader = renderToStaticMarkup(React.createElement(ModalHeader, {
			title: 'Edit reminder', closeLabel: 'Close reminder editor', onClose: vi.fn(),
		}));
		expect(pluginHeader).toContain('title="Close"');
		expect(pluginHeader).not.toContain('>Cancel</button>');
	});

	it('keeps save as the only form submit action', () => {
		const markup = renderEditor();
		expect(button(markup, 'save-reminder')).toContain('type="submit"');
		expect(button(markup, 'toggle-delete-confirm')).toContain('type="button"');
		expect(button(markup, 'toggle-picker')).toContain('type="button"');
		expect(button(markup, 'toggle-priority')).toContain('type="button"');
		expect(markup).not.toContain('data-action="delete-reminder"');
	});

	it('disables fields and actions during a save', () => {
		const markup = renderEditor({ saving: true });
		for (const action of ['save-reminder', 'toggle-delete-confirm', 'toggle-picker', 'toggle-priority']) {
			expect(button(markup, action)).toContain('disabled=""');
		}
		expect(markup).toContain('contentEditable="false"');
		expect(markup).toMatch(/<textarea[^>]*disabled=""/);
		expect(markup).toContain('aria-label="Saving reminder"');
	});

	it('keeps the hidden editor inert while a picker is active', () => {
		const markup = renderEditor({ isActive: false, canInteract: false });
		expect(markup).toContain('aria-hidden="true"');
		expect(markup).toContain('inert=""');
		expect(markup).toContain('contentEditable="false"');
	});
});
