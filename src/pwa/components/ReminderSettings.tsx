import { useState } from 'react';
import { Check } from 'lucide-react';
import { PwaButton as Button } from './PwaButton';
import { SettingsRow } from './SettingsRow';
import { SettingsSection } from './SettingsSection';
import type { RemindersSettings } from '../settings-store';
import type { PwaPreferences } from '../preferences';
import type { HomeScreenPlatform } from '../hooks/useHomeScreenInstall';

export function ReminderSettings({ model, homeScreenPlatform, onPreferencesChange }: {
	model: RemindersSettings | null;
	homeScreenPlatform: HomeScreenPlatform | null;
	onPreferencesChange: (patch: Partial<PwaPreferences>) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const push = model?.push;
	const available = model?.ready && model.connected;
	return <SettingsSection title="Reminders">
		{!available ? <SettingsRow description={!model?.ready ? 'Loading reminder settings…' : 'Open a fresh web app link from Obsidian to connect Reminders.'} /> : <>
			<SettingsRow title="Push notifications" description={<span aria-live="polite">{push?.status ?? (push?.phase === 'enabled' ? 'Alerts are enabled on this device.' : 'Get alerts when Crate is closed.')}</span>}>
				{push?.phase === 'enabled' ? <span className="settings-status is-success"><Check size={12} /> On</span>
					: push?.phase === 'checking' ? <span className="settings-status" role="status">Checking…</span>
					: push?.phase === 'blocked' ? <span className="settings-status">Blocked</span>
					: homeScreenPlatform === 'ios' || push?.phase === 'install' ? <span className="settings-status">Install first</span>
					: push?.phase === 'off' || push?.phase === 'error' ? <Button size="touch" className="settings-action-button" data-action="enable-push" onClick={model.onEnablePush}>{push.phase === 'error' ? 'Retry' : 'Enable'}</Button>
					: <span className="settings-status">Not supported</span>}
			</SettingsRow>
			<SettingsRow title="All-day alert" description="Managed in Obsidian."><span className="settings-value">{model.config.allDayNotificationTime ?? 'Not set'}</span></SettingsRow>
			<SettingsRow as="label" className="settings-row--preference" title="Upcoming range">
				<span className="settings-preference-control settings-preference-control--days">
					<input aria-label="Upcoming range (days)" className="settings-preference-input" type="number" inputMode="numeric"
						min={1} step={1} value={draft ?? String(model.config.upcomingDays)} onChange={event => setDraft(event.currentTarget.value)}
						onBlur={() => {
							if (draft === null) return;
							const days = Number(draft);
							if (Number.isSafeInteger(days) && days >= 1) onPreferencesChange({ upcomingDays: days });
							setDraft(null);
						}} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
					<span className="settings-preference-unit" aria-hidden="true">days</span>
				</span>
			</SettingsRow>
		</>}
	</SettingsSection>;
}
