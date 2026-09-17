import { useEffect } from 'react';
import { deriveReminderDraftContentMetadata } from '@/reminders/core/reminderDraft';

let prepared = false;

/** Compile the date parser's cold regular expressions outside the opening tap. */
export function usePrepareReminderEditor(enabled: boolean): void {
	useEffect(() => {
		if (!enabled || prepared) return;
		const prepare = () => {
			if (document.visibilityState !== 'visible') return;
			// Exercise the same matching and parsing paths as an existing reminder.
			// Discard the result; no user content or relative dates are cached.
			deriveReminderDraftContentMetadata('Prepare reminder Jan 15, 2030 at 10am', ['Inbox'], 'Inbox');
			prepared = true;
		};
		if (typeof window.requestIdleCallback === 'function') {
			const id = window.requestIdleCallback(prepare);
			return () => window.cancelIdleCallback(id);
		}
		// Let browsers without idle callbacks paint the loaded list first.
		const id = window.setTimeout(prepare, 200);
		return () => window.clearTimeout(id);
	}, [enabled]);
}
