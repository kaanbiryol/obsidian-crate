import { setIcon } from 'obsidian';
import { EditorView, WidgetType } from '@codemirror/view';
import type CratePlugin from '@/main';
import type { Reminder } from '@/reminders/types/plugin-reminder';
import { openReminderEditModal } from '@/reminders/ui/modals';
import { rebuildCheckboxLine } from '@/reminders/utils/checkboxParser';
import type { LineReminderMappingService } from '@/reminders/services/lineReminderMapping';
import { parseStoredReminderDate } from '@/reminders/utils/reminderDate';

export function isRecurrenceText(text: string): boolean {
	const recurrencePatterns = /^(every|daily|weekly|monthly|yearly)\b/i;
	return recurrencePatterns.test(text.trim());
}

function getVariantColors(variant: string): { bg: string; text: string } {
	const variantMap: Record<string, { bg: string; text: string }> = {
		primary: { bg: 'hsl(var(--heroui-primary) / 0.15)', text: 'hsl(var(--heroui-primary) / 1)' },
		secondary: { bg: 'hsl(var(--heroui-secondary) / 0.15)', text: 'hsl(var(--heroui-secondary) / 1)' },
		success: { bg: 'hsl(var(--heroui-success) / 0.15)', text: 'hsl(var(--heroui-success) / 1)' },
		warning: { bg: 'hsl(var(--heroui-warning) / 0.15)', text: 'hsl(var(--heroui-warning) / 1)' },
		danger: { bg: 'hsl(var(--heroui-danger) / 0.15)', text: 'hsl(var(--heroui-danger) / 1)' },
	};
	return variantMap[variant] || variantMap.primary;
}

export class InlineChipWidget extends WidgetType {
	private readonly type: 'date' | 'priority';
	private readonly text: string;
	private readonly displayText: string;
	private readonly plugin: CratePlugin;
	private readonly filePath: string;
	private readonly lineNum: number;
	private readonly mappingService: LineReminderMappingService;
	private readonly isCompleted: boolean;
	private readonly view: EditorView;
	private readonly lineFrom: number;
	private readonly lineTo: number;

	constructor(
		type: 'date' | 'priority',
		text: string,
		displayText: string,
		plugin: CratePlugin,
		filePath: string,
		lineNum: number,
		mappingService: LineReminderMappingService,
		isCompleted: boolean,
		view: EditorView,
		lineFrom: number,
		lineTo: number,
	) {
		super();
		this.type = type;
		this.text = text;
		this.displayText = displayText;
		this.plugin = plugin;
		this.filePath = filePath;
		this.lineNum = lineNum;
		this.mappingService = mappingService;
		this.isCompleted = isCompleted;
		this.view = view;
		this.lineFrom = lineFrom;
		this.lineTo = lineTo;
	}

	eq(other: InlineChipWidget): boolean {
		return (
			this.type === other.type &&
			this.text === other.text &&
			this.lineNum === other.lineNum &&
			this.isCompleted === other.isCompleted &&
			this.lineFrom === other.lineFrom &&
			this.lineTo === other.lineTo
		);
	}

	toDOM(): HTMLElement {
		const chip = document.createElement('span');
		chip.setCssProps({
			display: 'inline-flex',
			'align-items': 'center',
			gap: '4px',
			padding: '3px 8px',
			'border-radius': '12px',
			'font-size': 'var(--reminder-font-sm)',
			'font-weight': 'var(--reminder-font-weight-medium)',
			'margin-left': '8px',
			'margin-right': '2px',
			'vertical-align': 'baseline',
			cursor: 'pointer',
			opacity: this.isCompleted ? '0.5' : '1',
		});

		const iconSpan = document.createElement('span');
		iconSpan.setCssProps({
			display: 'inline-flex',
			'align-items': 'center',
			width: '12px',
			height: '12px',
		});

		const textSpan = document.createElement('span');

		if (this.type === 'date') {
			const colors = getVariantColors('success');
			chip.setCssProps({
				'background-color': colors.bg,
				color: colors.text,
			});
			setIcon(iconSpan, isRecurrenceText(this.text) ? 'repeat' : 'calendar');
			textSpan.textContent = this.displayText;
			chip.appendChild(iconSpan);
			chip.appendChild(textSpan);
		} else {
			const colors = getVariantColors('danger');
			chip.setCssProps({
				'background-color': colors.bg,
				color: colors.text,
				padding: '5px 8px',
			});
			const priorityIconSpan = document.createElement('span');
			priorityIconSpan.setCssProps({
				display: 'inline-flex',
				'align-items': 'center',
				width: '14px',
				height: '14px',
			});
			setIcon(priorityIconSpan, 'flag');
			const svg = priorityIconSpan.querySelector('svg');
			if (svg) {
				svg.setCssProps({ fill: 'currentColor' });
			}
			chip.appendChild(priorityIconSpan);
		}

		chip.addEventListener('mousedown', (event) => {
			event.stopPropagation();
			event.preventDefault();
			void this.openEditModal();
		});

		return chip;
	}

	private async openEditModal(): Promise<void> {
		const reminderId = this.mappingService.getReminderForLine(this.filePath, this.lineNum);
		if (!reminderId) {
			return;
		}

		const reminder = await this.plugin.storage.getByIdAsync(reminderId);
		if (!reminder) {
			return;
		}

		openReminderEditModal(this.plugin, reminder, (action, updatedReminder) => {
			if (action === 'saved' && updatedReminder) {
				this.updateMarkdownLine(updatedReminder);
			} else if (action === 'deleted') {
				this.deleteMarkdownLine();
			}
		});
	}

	private updateMarkdownLine(updated: Reminder): void {
		setTimeout(() => {
			const doc = this.view.state.doc;
			if (this.lineFrom >= doc.length || this.lineTo > doc.length) {
				return;
			}

			const dueDate = parseStoredReminderDate(updated);

			const newLine = rebuildCheckboxLine(
				'',
				updated.completed,
				updated.content,
				dueDate,
				updated.priority,
				undefined,
				updated.recurrence,
				!!updated.dueDatetime,
			);

			const lineText = doc.sliceString(this.lineFrom, this.lineTo);
			const indentMatch = lineText.match(/^(\s*)/);
			const indent = indentMatch ? indentMatch[1] : '';

			this.view.dispatch({
				changes: {
					from: this.lineFrom,
					to: this.lineTo,
					insert: indent + newLine.trimStart(),
				},
			});
		}, 50);
	}

	private deleteMarkdownLine(): void {
		setTimeout(() => {
			const doc = this.view.state.doc;
			if (this.lineFrom >= doc.length) {
				return;
			}

			const line = doc.lineAt(this.lineFrom);
			let deleteFrom = line.from;
			let deleteTo = line.to;

			if (line.number < doc.lines) {
				deleteTo = doc.line(line.number + 1).from;
			} else if (line.number > 1) {
				deleteFrom = doc.line(line.number - 1).to;
			}

			this.view.dispatch({
				changes: { from: deleteFrom, to: deleteTo, insert: '' },
			});

			this.mappingService.unregisterLine(this.filePath, line.number);
		}, 50);
	}

	ignoreEvent(): boolean {
		return false;
	}
}
