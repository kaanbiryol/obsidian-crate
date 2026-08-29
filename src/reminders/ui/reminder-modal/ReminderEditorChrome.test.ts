import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DeleteConfirmationModal } from '../../components/DeleteConfirmationModal';
import { AddReminderModalHeader } from './AddReminderModalHeader';
import { DatePickerModal } from './DatePickerModal';
import { ProjectPickerModal } from './ProjectPickerModal';
import { RecurrencePickerModal } from './RecurrencePickerModal';
import { ReminderActionChips } from './ReminderActionChips';

describe('reminder editor chrome', () => {
    it('uses sentence case and an explicit save action', () => {
        const markup = renderToStaticMarkup(React.createElement(AddReminderModalHeader, {
            isEditing: true,
            canSubmit: true,
            onDelete: vi.fn(),
            onClose: vi.fn(),
            onSubmit: vi.fn(),
        }));

        expect(markup).toContain('Edit reminder');
        expect(markup).toContain('Save');
        expect(markup).toContain('aria-label="Save reminder"');
        expect(markup).not.toContain('lucide-check');
    });

    it('labels unset priority and recurrence actions', () => {
        const markup = renderToStaticMarkup(React.createElement(ReminderActionChips, {
            dueDate: null,
            project: 'Inbox',
            defaultProject: 'Inbox',
            priority: 4,
            recurrence: undefined,
            dueDateChanged: false,
            projectChanged: false,
            hasMounted: false,
            onOpenDatePicker: vi.fn(),
            onOpenProjectPicker: vi.fn(),
            onOpenRecurrencePicker: vi.fn(),
            onTogglePriority: vi.fn(),
        }));

        expect(markup).toContain('Priority');
        expect(markup).toContain('Repeat');
    });

    it('offers removal actions for an existing schedule and recurrence', () => {
        const dateMarkup = renderToStaticMarkup(React.createElement(DatePickerModal, {
            isOpen: true,
            onClose: vi.fn(),
            animationConfig: { enabled: false },
            pickerMode: 'replace',
            dueDate: '2026-08-29',
            hasTime: false,
            isDark: true,
            onDateTimeChange: vi.fn(),
        }));
        const recurrenceMarkup = renderToStaticMarkup(React.createElement(RecurrencePickerModal, {
            isOpen: true,
            onClose: vi.fn(),
            animationConfig: { enabled: false },
            pickerMode: 'replace',
            isDark: true,
            recurrence: { frequency: 'daily', hour: 9, minute: 0 },
            onApply: vi.fn(),
        }));

        expect(dateMarkup).toContain('Remove schedule');
        expect(dateMarkup).toContain('Next week');
        expect(recurrenceMarkup).toContain('Remove repeat');
    });

    it('keeps removal actions hidden for new date and recurrence selections', () => {
        const dateMarkup = renderToStaticMarkup(React.createElement(DatePickerModal, {
            isOpen: true,
            onClose: vi.fn(),
            animationConfig: { enabled: false },
            pickerMode: 'replace',
            dueDate: null,
            isDark: true,
            onDateTimeChange: vi.fn(),
        }));
        const recurrenceMarkup = renderToStaticMarkup(React.createElement(RecurrencePickerModal, {
            isOpen: true,
            onClose: vi.fn(),
            animationConfig: { enabled: false },
            pickerMode: 'replace',
            isDark: true,
            onApply: vi.fn(),
        }));

        expect(dateMarkup).toContain('Select date');
        expect(dateMarkup).not.toContain('Remove schedule');
        expect(recurrenceMarkup).not.toContain('Remove repeat');
    });

    it('uses a grouped, calmly selected project list', () => {
        const markup = renderToStaticMarkup(React.createElement(ProjectPickerModal, {
            isOpen: true,
            onClose: vi.fn(),
            animationConfig: { enabled: false },
            pickerMode: 'replace',
            projects: ['Inbox', 'Work'],
            project: 'Work',
            defaultProject: 'Inbox',
            isDark: true,
            onSelectProject: vi.fn(),
        }));

        expect(markup).toContain('>Project<');
        expect(markup).toContain('project-picker-list');
        expect(markup).toContain('aria-selected="true"');
        expect(markup).not.toContain('Select Project');
    });

    it('renders a compact delete confirmation without redundant chrome', () => {
        const markup = renderToStaticMarkup(React.createElement(DeleteConfirmationModal, {
            isOpen: true,
            onClose: vi.fn(),
            onConfirm: vi.fn(),
            animationConfig: { enabled: false },
            message: 'Delete "Buy milk"? This can\'t be undone.',
        }));

        expect(markup).toContain('Delete reminder?');
        expect(markup).toContain('Delete &quot;Buy milk&quot;? This can&#x27;t be undone.');
        expect(markup).not.toContain('delete-confirmation-close');
        expect(markup).not.toContain('lucide-triangle-alert');
    });
});
