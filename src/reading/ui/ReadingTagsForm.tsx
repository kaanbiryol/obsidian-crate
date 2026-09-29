import React, { useId, useRef, useState } from 'react';
import { Button } from '../../ui/shared/Button';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';

function parseTags(value: string): string[] {
	return value.split(/[\s,]+/u).map(tag => tag.replace(/^#+/, '')).filter(Boolean);
}

export function ReadingTagsForm({ id: formId, initialTags, busy, error, onSave }: {
	id: string; initialTags: string[]; busy: boolean; error: string | null;
	onSave: (tags: string[]) => void;
}) {
	const [tags, setTags] = useState(() => [...new Set(initialTags)]);
	const [draft, setDraft] = useState('');
	const input = useRef<HTMLInputElement>(null);
	const composing = useRef(false);
	const id = useId();
	const commit = (value: string) => {
		setTags(current => [...new Set([...current, ...parseTags(value)])]);
		setDraft('');
	};
	const change = (value: string) => {
		if (composing.current) { setDraft(value); return; }
		const boundary = value.search(/[\s,]+[^\s,]*$/u);
		if (boundary < 0) { setDraft(value); return; }
		setTags(current => [...new Set([...current, ...parseTags(value.slice(0, boundary))])]);
		setDraft(value.slice(boundary).replace(/^[\s,]+/u, ''));
	};
	return <form id={formId} className="crate-reading__capture" onSubmit={event => {
		event.preventDefault();
		if (!busy && !composing.current) onSave([...new Set([...tags, ...parseTags(draft)])]);
	}}>
		<div className="crate-field crate-field--rounded">
			<label className="crate-field__label crate-field__label--hidden" htmlFor={id}>Tags</label>
			<div className="crate-reading-tags__control">
				{tags.map(tag => <Button key={tag} className="crate-reading-tags__chip" aria-label={`Remove tag ${tag}`} disabled={busy} preventFocusOnPress onClick={() => {
					setTags(current => current.filter(value => value !== tag));
					input.current?.focus({ preventScroll: true });
				}}><span>#{tag}</span><ThemeIcon id="x" size="xs" aria-hidden="true" /></Button>)}
				<input ref={input} id={id} className="crate-text-input" data-initial-focus aria-describedby={`${id}-help`} value={draft} disabled={busy}
					placeholder="Add a tag" autoCapitalize="none" autoComplete="off" spellCheck={false} enterKeyHint="enter"
					onChange={event => change(event.target.value)}
					onCompositionStart={() => { composing.current = true; }}
					onCompositionEnd={event => { composing.current = false; change(event.currentTarget.value); }}
					onKeyDown={event => {
						if (composing.current || event.nativeEvent.isComposing) return;
						if (event.key === 'Enter') { event.preventDefault(); commit(draft); }
						if (event.key === 'Backspace' && !draft && tags.length) {
							event.preventDefault(); setDraft(tags[tags.length - 1]!); setTags(tags.slice(0, -1));
						}
					}} />
			</div>
			<span id={`${id}-help`} className="crate-field__description">Use a space to separate tags.</span>
		</div>
		{error && <p role="alert">{error}</p>}
	</form>;
}
