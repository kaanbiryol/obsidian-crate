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
	return <section className="pwa-reminder-sync-error" aria-label="Offline copy unavailable">
		<div className="pwa-reminder-sync-error__copy">
			<strong>Offline copy unavailable</strong>
			<span role="status">{explanations[problem]}</span>
		</div>
		{problem !== 'unsupported' && <div className="pwa-reminder-sync-error__actions">
			<button type="button" disabled={isOffline || busy} onClick={() => { void rebuild(); }}>Rebuild offline copy</button>
		</div>}
	</section>;
}
