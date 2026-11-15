import { WidgetType } from '@codemirror/view';

/**
 * What stands before a description on its reminder's line, shown as the bar
 * the description has under its title. Deletes as one.
 */
export class DescriptionMarkerWidget extends WidgetType {
	eq() { return true; }

	toDOM() {
		return createSpan({ cls: 'crate-reminder-description-marker', attr: { 'aria-label': 'Description' } });
	}
}

/** A line break in a description shown on its reminder's line. */
export class DescriptionBreakWidget extends WidgetType {
	eq() { return true; }

	toDOM() {
		return createSpan({ cls: 'crate-reminder-description-break', text: '↵', attr: { 'aria-label': 'New line' } });
	}
}
