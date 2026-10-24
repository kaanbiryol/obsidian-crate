import React, { useId } from 'react';
import { useOpenReadingForm } from './open-forms';

/** Header-submitted note editor: the excerpt for context, then one growing field. */
export function ReadingHighlightNoteForm({ id: formId, excerpt, note, busy, canSave, error, onChange, onSave }: {
	id: string; excerpt: string; note: string; busy: boolean; canSave: boolean; error: string | null;
	onChange: (note: string) => void; onSave: () => void;
}) {
	useOpenReadingForm();
	const id = useId();
	return <form id={formId} className="crate-reading-note" onSubmit={event => {
		event.preventDefault();
		if (canSave) onSave();
	}}>
		<blockquote className="crate-reading-note__excerpt">{excerpt}</blockquote>
		<div className="crate-field">
			<label className="crate-field__label crate-field__label--hidden" htmlFor={id}>Your note</label>
			<textarea id={id} className="crate-text-input crate-reading-note__input" data-initial-focus value={note} maxLength={4000} rows={5}
				placeholder="Write a note" readOnly={busy} aria-invalid={error ? true : undefined}
				onChange={event => onChange(event.target.value)}
				onKeyDown={event => {
					if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
					event.preventDefault();
					event.currentTarget.form?.requestSubmit();
				}} />
			{error && <span className="crate-field__error" role="alert">{error}</span>}
		</div>
	</form>;
}
