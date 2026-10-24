import React from 'react';
import { TextField } from '../../ui/shared/TextField';
import { Button } from '../../ui/shared/Button';
import { useOpenReadingForm } from './open-forms';

export function SaveLinkForm({ url, onUrl, onSave, onCancel, saving, error, id, headerAction = false }: {
	id?: string; headerAction?: boolean;
	url: string; onUrl: (value: string) => void;
	onSave: () => void; onCancel: () => void; saving: boolean; error?: string | null;
}) {
	useOpenReadingForm();
	return <form id={id} className="crate-reading__capture" onSubmit={event => { event.preventDefault(); if (!saving) onSave(); }}>
		<TextField label="Link" hideLabel data-initial-focus type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://…" required maxLength={8192} value={url} onChange={event => onUrl(event.target.value)} disabled={saving} />
		{error && <p className="crate-reading__notice" role="alert">{error}</p>}
		{!headerAction && <div className="crate-dialog-actions crate-reading-dialog__actions"><Button variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button><Button variant="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save link'}</Button></div>}
	</form>;
}
