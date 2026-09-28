import { SettingsAction } from './SettingsAction';
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
	return <>
		<SettingsRow title="Device storage"><span className="settings-value" role="status">{status === 'persistent' ? 'Protected' : status === 'checking' ? 'Checking…' : status === 'unavailable' ? 'Unavailable' : 'Best effort'}</span></SettingsRow>
		<p className="settings-help">{status === 'persistent' ? 'Sync pending changes before clearing site data.' : 'Your browser may remove offline data. Sync pending changes to keep them safe.'}</p>
		{status === 'best-effort' && <SettingsAction disabled={requesting} aria-busy={requesting} onClick={() => {
			setRequesting(true);
			void browserStorageStatus(true).then(setStatus).finally(() => setRequesting(false));
		}}>Protect offline data</SettingsAction>}
	</>;
}
