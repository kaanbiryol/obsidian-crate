import React from 'react';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';
import { TextField } from '../../ui/shared/TextField';
import { Button } from '../../ui/shared/Button';

export function SaveLinkForm({ url, onUrl, onSave, onCancel, saving, error, id, headerAction = false, rounded = true, captureOnDevice = false }: {
	id?: string; headerAction?: boolean; rounded?: boolean; captureOnDevice?: boolean;
	url: string; onUrl: (value: string) => void;
	onSave: () => void; onCancel: () => void; saving: boolean; error?: string | null;
}) {
	return <form id={id} className="crate-reading__capture" onSubmit={event => { event.preventDefault(); if (!saving) onSave(); }}>
		<p>{captureOnDevice ? "This device downloads article text into your vault. Saved notes sync normally." : "Your server downloads article text from links you save."}</p>
		<TextField fieldClassName={rounded ? 'crate-field--rounded' : undefined} label="Link" hideLabel leadingIcon={<ThemeIcon id="link" size="m" aria-hidden="true" />} data-initial-focus type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://…" required maxLength={8192} value={url} onChange={event => onUrl(event.target.value)} disabled={saving} />
		{error && <p className="crate-reading__notice" role="alert">{error}</p>}
		{!headerAction && <div className="crate-dialog-actions crate-reading-dialog__actions"><Button variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button><Button variant="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save link'}</Button></div>}
	</form>;
}
