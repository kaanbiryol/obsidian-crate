import React from 'react';
import { ThemeIcon } from '../../reminders/components/theme-icon';
import { Button } from '../../ui/shared/Button';

export function SaveLinkForm({ url, title, onUrl, onTitle, onSave, onCancel, saving, error }: {
	url: string; title: string; onUrl: (value: string) => void; onTitle: (value: string) => void;
	onSave: () => void; onCancel: () => void; saving: boolean; error?: string | null;
}) {
	return <form className="crate-reading__capture" onSubmit={event => { event.preventDefault(); onSave(); }}>
		<p>Something good to come back to.</p>
		<label>Link<div className="crate-reading__url-field"><ThemeIcon id="link" size="m" aria-hidden="true" /><input data-initial-focus type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://…" required maxLength={8192} value={url} onChange={event => onUrl(event.target.value)} disabled={saving} /></div></label>
		<label>Title (optional)<input placeholder="Give it a name" maxLength={1000} value={title} onChange={event => onTitle(event.target.value)} disabled={saving} /></label>
		{error && <p className="crate-reading__notice" role="alert">{error}</p>}
		<div className="crate-reading-dialog__actions"><Button variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button><Button variant="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save link'}<ThemeIcon id="arrow-up-right" size="m" aria-hidden="true" /></Button></div>
	</form>;
}
