export interface KeyboardDoneSaveState {
	canSubmit: boolean;
	documentHasFocus: boolean;
	documentIsVisible: boolean;
	hadRecentPagePointer: boolean;
	hasEditorFocus: boolean;
	relatedTargetWasNull: boolean;
}

/**
 * iOS does not expose an event for its keyboard accessory Done button. The
 * closest reliable signal is an editor blur which was not caused by focus
 * navigation, a page tap, or the app losing focus.
 */
export function shouldSaveFromKeyboardDone({
	canSubmit,
	documentHasFocus,
	documentIsVisible,
	hadRecentPagePointer,
	hasEditorFocus,
	relatedTargetWasNull,
}: KeyboardDoneSaveState): boolean {
	return canSubmit
		&& documentHasFocus
		&& documentIsVisible
		&& !hadRecentPagePointer
		&& !hasEditorFocus
		&& relatedTargetWasNull;
}
