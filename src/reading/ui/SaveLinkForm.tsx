import { youtubeVideoId } from '../core/youtube';
import React from 'react';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';
import { TextField } from '../../ui/shared/TextField';
import { Button } from '../../ui/shared/Button';
import { useOpenReadingForm } from './open-forms';

export function SaveLinkForm({ url, onUrl, onSave, onCancel, saving, error, id, headerAction = false, captureOnDevice = false, encrypted = false }: {
	id?: string; headerAction?: boolean; captureOnDevice?: boolean; encrypted?: boolean;
	url: string; onUrl: (value: string) => void;
	onSave: () => void; onCancel: () => void; saving: boolean; error?: string | null;
}) {
	useOpenReadingForm();
	const privacy = encrypted ? ' It doesn’t keep the link, and this device encrypts the result.' : '';
	return <form id={id} className="crate-reading__capture" onSubmit={event => { event.preventDefault(); if (!saving) onSave(); }}>
		<p>{youtubeVideoId(url) ? `${captureOnDevice ? "This device" : "Your server"} fetches video details and available transcripts from YouTube.${privacy} Video thumbnails load from YouTube when you browse Reading.` : captureOnDevice ? "This device downloads article text into your vault. Saved notes sync normally." : `Your server downloads article text from links you save.${privacy}`}</p>
		<TextField label="Link" hideLabel leadingIcon={<ThemeIcon id="link" size="m" aria-hidden="true" />} data-initial-focus type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://…" required maxLength={8192} value={url} onChange={event => onUrl(event.target.value)} disabled={saving} />
		{error && <p className="crate-reading__notice" role="alert">{error}</p>}
		{!headerAction && <div className="crate-dialog-actions crate-reading-dialog__actions"><Button variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button><Button variant="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save link'}</Button></div>}
	</form>;
}
