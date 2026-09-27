import { downloadJson } from '../download';
import { PwaButton as BaseButton } from './PwaButton';
import React, { useState } from 'react';
import type { PendingReminderChange } from '../reminder-outbox-types';

export function ExpiredReminderChangeActions({ change, onDiscard }: {
	change: PendingReminderChange;
	onDiscard: (operationId: string, reviewedChange?: string) => void;
}) {
	const [exportedChange, setExportedChange] = useState<string | null>(null);
	const [reviewed, setReviewed] = useState(false);
	const exportChange = () => {
		downloadJson('crate-expired-change.json', { format: 'crate-expired-reminder-change-v1', origin: window.location.origin, change });
		setExportedChange(JSON.stringify(change)); setReviewed(false);
	};
	return <>
		<BaseButton variant="ghost" size="touch" type="button" onClick={exportChange}>Export expired change</BaseButton>
		{exportedChange !== null && <>
			<label className="pwa-reminder-recovery-confirm"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.currentTarget.checked)} /> I saved the export and compared current reminders</label>
			<BaseButton variant="ghost" size="touch" type="button" disabled={!reviewed || exportedChange !== JSON.stringify(change)} onClick={() => onDiscard(change.operationId, exportedChange)}>Remove exported change from device</BaseButton>
		</>}
	</>;
}
