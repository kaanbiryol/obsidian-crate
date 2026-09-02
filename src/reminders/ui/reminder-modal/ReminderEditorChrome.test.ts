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
        expect(markup).toContain('reminder-editor-header');
        expect(markup).toContain('reminder-editor-header-side is-right');
        expect(markup).toContain('<h2 class="reminder-header-title">');
        expect(markup).not.toContain('data-icon="check"');
        expect(markup).not.toContain('w-16');
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
        expect(dateMarkup).toContain('>Schedule<');
        expect(dateMarkup).toContain('Quick options');
        expect(dateMarkup).toContain('This evening');
        expect(dateMarkup).toContain('Next week');
        expect(dateMarkup).toContain('crate-reminder-picker-surface is-date-picker');
        expect(dateMarkup).toContain('role="dialog"');
        expect(dateMarkup).toContain('aria-label="Schedule reminder"');
        expect(dateMarkup).toContain('picker-header-action');
        expect(dateMarkup).toContain('picker-schedule-fields');
        expect(dateMarkup).toContain('type="date"');
        expect(dateMarkup).toContain('type="time"');
        expect(dateMarkup).not.toContain('date-calendar-grid');
        expect(dateMarkup).toContain('>Done<');
        expect(recurrenceMarkup).toContain('Remove repeat');
        expect(recurrenceMarkup).toContain('crate-reminder-picker-surface is-recurrence-picker');
        expect(recurrenceMarkup).toContain('>Repeat<');
        expect(recurrenceMarkup).toContain('>Repeats<');
        expect(recurrenceMarkup).toContain('>Frequency<');
        expect(recurrenceMarkup).toContain('>Interval<');
        expect(recurrenceMarkup).toContain('>Reminder time<');
        expect(recurrenceMarkup).toContain('data-icon="minus"');
        expect(recurrenceMarkup).toContain('data-icon="plus"');
        expect(recurrenceMarkup).toContain('role="tabpanel"');
        expect(recurrenceMarkup).toContain('tabindex="-1"');
        expect(recurrenceMarkup).toContain('>Done<');
    });

    it('keeps interval separate from weekly and monthly repeat options', () => {
        const weeklyMarkup = renderToStaticMarkup(React.createElement(RecurrencePickerModal, {
            isOpen: true,
            onClose: vi.fn(),
            animationConfig: { enabled: false },
            pickerMode: 'replace',
            isDark: true,
            recurrence: { frequency: 'weekly', interval: 2, daysOfWeek: [1], hour: 9, minute: 0 },
            onApply: vi.fn(),
        }));
        const monthlyMarkup = renderToStaticMarkup(React.createElement(RecurrencePickerModal, {
            isOpen: true,
            onClose: vi.fn(),
            animationConfig: { enabled: false },
            pickerMode: 'replace',
            isDark: true,
            recurrence: { frequency: 'monthly', interval: 2, dayOfMonth: 15, hour: 9, minute: 0 },
            onApply: vi.fn(),
        }));

        expect(weeklyMarkup).toContain('>Interval<');
        expect(weeklyMarkup).toContain('>Days<');
        expect(weeklyMarkup).toContain('>weeks<');
        expect(monthlyMarkup).toContain('>Interval<');
        expect(monthlyMarkup).toContain('>Month day<');
        expect(monthlyMarkup).toContain('>months<');
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

        expect(dateMarkup).toContain('>Schedule<');
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
        expect(markup).toContain('crate-reminder-picker-surface is-project-picker');
        expect(markup).toContain('aria-label="Close project selection"');
        expect(markup).toContain('data-icon="x"');
        expect(markup).not.toContain('data-icon="chevron-left"');
        expect(markup).toContain('aria-selected="true"');
        expect(markup).toContain('tabindex="0"');
        expect(markup).toContain('aria-label="Select project"');
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
        expect(markup).not.toContain('data-icon="triangle-alert"');
    });
});
