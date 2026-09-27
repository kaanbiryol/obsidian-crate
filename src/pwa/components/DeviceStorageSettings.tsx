import { PwaButton as BaseButton } from './PwaButton';
import React, { useEffect, useState } from 'react';
import { browserStorageStatus, type BrowserStorageStatus } from '../browser-storage';
import { SettingsRow } from './SettingsRow';

export function DeviceStorageSettings() {
	const [status, setStatus] = useState<BrowserStorageStatus | 'checking'>('checking');
	const [requesting, setRequesting] = useState(false);
	useEffect(() => {
		let active = true;
		void browserStorageStatus().then(value => { if (active) setStatus(value); });
		return () => { active = false; };
	}, []);
	return <SettingsRow className="settings-row--storage" title="Device storage" description={<>
			<span role="status">{status === 'persistent' ? 'Persistent storage granted.' : status === 'checking' ? 'Checking storage…' : status === 'unavailable' ? 'Storage protection is unavailable in this browser.' : 'Best effort storage. This browser may evict offline data.'} Pending changes exist only here until synced. Export them before clearing site data.</span>
			{status === 'persistent' && <span>Clearing site data or losing this device can still erase offline changes.</span>}
		</>}>
		{status === 'best-effort' && <BaseButton size="touch" className="settings-action-button" type="button" disabled={requesting} onClick={() => {
			setRequesting(true);
			void browserStorageStatus(true).then(setStatus).finally(() => setRequesting(false));
		}}>Protect offline data</BaseButton>}
	</SettingsRow>;
}
