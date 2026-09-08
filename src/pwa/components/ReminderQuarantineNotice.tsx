import React, { useState } from 'react';
import type { QuarantinedReminderEntry } from '../reminder-outbox-storage';

export function ReminderQuarantineNotice({ entries, folderPath, onRemove, kind = 'changes' }: {
	entries: QuarantinedReminderEntry[];
	folderPath: string;
	onRemove: (entries: QuarantinedReminderEntry[]) => Promise<boolean>;
	kind?: 'changes' | 'draft';
}) {
	const [exported, setExported] = useState<QuarantinedReminderEntry[]>([]);
	const [reviewed, setReviewed] = useState(false);
	const [busy, setBusy] = useState(false);
	if (!entries.length) return null;
	const exportEntries = () => {
		const snapshot = entries.map(entry => ({ ...entry }));
		const blob = new Blob([JSON.stringify({ format: kind === 'draft' ? 'crate-saved-reminder-draft-v1' : 'crate-damaged-reminder-changes-v1', origin: window.location.origin,
			folderPath, entries: snapshot }, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url; link.download = kind === 'draft' ? 'crate-saved-draft.json' : 'crate-damaged-changes.json'; link.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
		setExported(snapshot); setReviewed(false);
	};
	const remove = async () => {
		if (!reviewed || busy) return;
		setBusy(true);
		try { if (await onRemove(exported)) { setExported([]); setReviewed(false); } }
		finally { setBusy(false); }
	};
	return <section className="pwa-reminder-sync-error" aria-label={kind === 'draft' ? 'Saved draft recovery' : 'Damaged pending changes'}>
		<div className="pwa-reminder-sync-error__copy">
			<strong>{kind === 'draft' ? 'Saved draft needs review' : `${entries.length} ${entries.length === 1 ? 'saved change needs' : 'saved changes need'} recovery`}</strong>
			<span role="status">{kind === 'draft' ? 'This saved draft cannot be restored into this editor. Its original text stays on this device until you export and review it.' : 'These entries cannot be read safely and will not be sent. Their original text stays on this device while other changes can sync.'}</span>
			<details><summary>Review damaged entries</summary>
				<p>Export the full text and compare it with current reminders before restoring any missing edits in Obsidian. An earlier attempt may already have synced.</p>
				<div className="pwa-reminder-recovery-preview">{entries.map((entry, index) => <div key={entry.key}><strong>Entry {index + 1}</strong><pre>{entry.raw.slice(0, 20_000)}</pre>
					{entry.raw.length > 20_000 && <p>Preview limited to 20,000 characters. The export contains the full text.</p>}
				</div>)}</div>
			</details>
			{exported.length > 0 && <label className="pwa-reminder-recovery-confirm"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.currentTarget.checked)} /> I saved and reviewed the export</label>}
		</div>
		<div className="pwa-reminder-sync-error__actions">
			<button type="button" onClick={exportEntries}>Export damaged entries</button>
			{exported.length > 0 && <button type="button" disabled={!reviewed || busy} onClick={() => { void remove(); }}>Remove exported copies from device</button>}
		</div>
	</section>;
}
