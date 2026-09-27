import { PwaButton } from './PwaButton';
import { PwaNotice } from './PwaNotice';
import React, { useState, useSyncExternalStore } from 'react';
import { reminderCacheHealth } from '../reminder-cache-database';

const explanations = {
	blocked: 'Close other Crate tabs and retry. An open tab is preventing access to the offline copy.',
	unsupported: 'This offline copy uses an unsupported format. Open the matching Crate version before changing browser data.',
	damaged: 'The saved copy is damaged or belongs to an older session or format. Rebuild it from the server. Pending changes and drafts stay on this device.',
	unavailable: 'Browser storage is unavailable. Check storage permissions and free space, then retry.',
};

export function ReminderCacheNotice({ isOffline, onRebuild }: { isOffline: boolean; onRebuild: () => Promise<void> }) {
	const problem = useSyncExternalStore(reminderCacheHealth.subscribe, reminderCacheHealth.getSnapshot);
	const [busy, setBusy] = useState(false);
	if (!problem) return null;
	const rebuild = async () => { setBusy(true); try { await onRebuild(); } finally { setBusy(false); } };
	return <PwaNotice title="Offline copy unavailable" aria-label="Offline copy unavailable" actions={problem !== 'unsupported' &&
		<PwaButton variant="ghost" size="touch" disabled={isOffline || busy} onClick={() => { void rebuild(); }}>Rebuild offline copy</PwaButton>}>
		<span role="status">{explanations[problem]}</span>
	</PwaNotice>;
}
