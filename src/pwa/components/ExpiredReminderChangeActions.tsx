import React, { useState } from 'react';
import type { PendingReminderChange } from '../reminder-outbox-types';

export function ExpiredReminderChangeActions({ change, onDiscard }: {
	change: PendingReminderChange;
	onDiscard: (operationId: string, reviewedChange?: string) => void;
}) {
	const [exportedChange, setExportedChange] = useState<string | null>(null);
	const [reviewed, setReviewed] = useState(false);
	const exportChange = () => {
		const blob = new Blob([JSON.stringify({ format: 'crate-expired-reminder-change-v1', origin: window.location.origin, change }, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url; link.download = 'crate-expired-change.json'; link.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
		setExportedChange(JSON.stringify(change)); setReviewed(false);
	};
	return <>
		<button type="button" onClick={exportChange}>Export expired change</button>
		{exportedChange !== null && <>
			<label className="pwa-reminder-recovery-confirm"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.currentTarget.checked)} /> I saved the export and compared current reminders</label>
			<button type="button" disabled={!reviewed || exportedChange !== JSON.stringify(change)} onClick={() => onDiscard(change.operationId, exportedChange)}>Remove exported change from device</button>
		</>}
	</>;
}
