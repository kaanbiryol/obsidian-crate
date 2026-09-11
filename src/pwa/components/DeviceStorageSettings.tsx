import React, { useEffect, useState } from 'react';
import { browserStorageStatus, type BrowserStorageStatus } from '../browser-storage';

export function DeviceStorageSettings() {
	const [status, setStatus] = useState<BrowserStorageStatus | 'checking'>('checking');
	const [requesting, setRequesting] = useState(false);
	useEffect(() => {
		let active = true;
		void browserStorageStatus().then(value => { if (active) setStatus(value); });
		return () => { active = false; };
	}, []);
	return <div className="settings-row">
		<div className="settings-row__copy">
			<strong>Device storage</strong>
			<span role="status">{status === 'persistent' ? 'Persistent storage granted.' : status === 'checking' ? 'Checking storage…' : status === 'unavailable' ? 'Storage protection is unavailable in this browser.' : 'Best effort storage. This browser may evict offline data.'} Pending changes exist only here until synced. Export them before clearing site data.</span>
			{status === 'persistent' && <span>Clearing site data or losing this device can still erase offline changes.</span>}
		</div>
		{status === 'best-effort' && <button className="settings-action-button" type="button" disabled={requesting} onClick={() => {
			setRequesting(true);
			void browserStorageStatus(true).then(setStatus).finally(() => setRequesting(false));
		}}>Protect offline data</button>}
	</div>;
}
