import { ChevronDown } from 'lucide-react';
import { normalizeListStyle } from '@/ui/shared/list-style';
import type { PwaPreferences } from '../preferences';
import { SettingsRow } from './SettingsRow';

export function ListStyleSetting({ preferences, onPreferencesChange }: {
	preferences: PwaPreferences;
	onPreferencesChange: (patch: Partial<PwaPreferences>) => void;
}) {
	return <SettingsRow as="label" className="settings-row--preference" title="List style" description="This device · reminders, projects, and Reading">
		<span className="settings-preference-control settings-preference-control--select">
			<select aria-label="List style" className="settings-preference-input" value={preferences.reminderListStyle}
				onChange={event => onPreferencesChange({ reminderListStyle: normalizeListStyle(event.currentTarget.value) })}>
				<option value="flat">Flat</option>
				<option value="cards">Cards</option>
			</select>
			<ChevronDown size={14} aria-hidden="true" />
		</span>
	</SettingsRow>;
}
