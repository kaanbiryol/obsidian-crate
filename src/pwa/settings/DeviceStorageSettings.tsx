import { ShieldCheck } from '@/ui/shared/icons/TablerIcon';
import { SettingsAction } from './SettingsAction';
import React, { useEffect, useState } from 'react';
import { browserStorageStatus, type BrowserStorageStatus } from '../storage/browser-storage';
import { SettingsRow } from './SettingsRow';
import { SettingsSection } from './SettingsSection';

/** Shown only while unsynced work sits in storage the browser may clear. */
export function DeviceStorageSettings({ unsynced }: { unsynced: boolean }) {
	const [status, setStatus] = useState<BrowserStorageStatus | 'checking'>('checking');
	const [requesting, setRequesting] = useState(false);
	useEffect(() => {
		let active = true;
		void browserStorageStatus().then(value => { if (active) setStatus(value); });
		return () => { active = false; };
	}, []);
	if (status !== 'best-effort' || !unsynced) return null;
	return <SettingsSection title="Device storage">
		<SettingsRow title="Offline data" description="Unsynced changes are in storage your browser may clear. Sync them, or add Crate to your home screen to keep them safe."><span className="settings-value" role="status">At risk</span></SettingsRow>
		<SettingsAction icon={ShieldCheck} disabled={requesting} aria-busy={requesting} onClick={() => {
			setRequesting(true);
			void browserStorageStatus(true).then(setStatus).finally(() => setRequesting(false));
		}}>Ask browser to keep data</SettingsAction>
	</SettingsSection>;
}
