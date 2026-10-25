import { downloadJson } from '../../storage/download';
import { PwaButton as BaseButton } from '../../components/PwaButton';
import React, { useState } from 'react';
import type { PendingReminderChange } from '../outbox/reminder-outbox-types';

/** Expired changes, and unconfirmed ones the server keeps rejecting, leave the device only after review. */
export function ExpiredReminderChangeActions({ change, onDiscard }: {
	change: PendingReminderChange;
	onDiscard: (operationId: string, reviewedChange?: string) => void;
}) {
	const [exportedChange, setExportedChange] = useState<string | null>(null);
	const [reviewed, setReviewed] = useState(false);
	const expired = change.reviewRequired;
	const exportChange = () => {
		downloadJson(expired ? 'crate-expired-change.json' : 'crate-unconfirmed-change.json', {
			format: expired ? 'crate-expired-reminder-change-v1' : 'crate-unconfirmed-reminder-change-v1', origin: window.location.origin, change,
		});
		setExportedChange(JSON.stringify(change)); setReviewed(false);
	};
	return <>
		<BaseButton variant="ghost" size="touch" type="button" onClick={exportChange}>{expired ? 'Export expired change' : 'Export change'}</BaseButton>
		{exportedChange !== null && <>
			<label className="pwa-reminder-recovery-confirm"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.currentTarget.checked)} /> I saved the export and compared current reminders</label>
			<BaseButton variant="ghost" size="touch" type="button" disabled={!reviewed || exportedChange !== JSON.stringify(change)} onClick={() => onDiscard(change.operationId, exportedChange)}>Remove exported change from device</BaseButton>
		</>}
	</>;
}
