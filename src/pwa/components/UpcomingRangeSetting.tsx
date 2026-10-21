import { useState } from 'react';
import type { PwaPreferences } from '../preferences';
import { SettingsRow } from './SettingsRow';

export function UpcomingRangeSetting({ days, onChange }: { days: number; onChange: (patch: Partial<PwaPreferences>) => void }) {
	const [draft, setDraft] = useState<string | null>(null);
	return <SettingsRow as="label" className="settings-row--preference" title="Upcoming range" description="Days shown in Upcoming.">
		<span className="settings-preference-control settings-preference-control--days">
			<input aria-label="Upcoming range (days)" className="settings-preference-input" type="number" inputMode="numeric"
				min={1} step={1} value={draft ?? String(days)} onChange={event => setDraft(event.currentTarget.value)}
				onBlur={() => {
					if (draft === null) return;
					const next = Number(draft);
					if (Number.isSafeInteger(next) && next >= 1) onChange({ upcomingDays: next });
					setDraft(null);
				}} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
			<span className="settings-preference-unit" aria-hidden="true">days</span>
		</span>
	</SettingsRow>;
}
