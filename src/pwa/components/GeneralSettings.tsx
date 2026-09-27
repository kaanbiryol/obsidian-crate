import { useRef } from 'react';
import { Toggle } from '@base-ui/react/toggle';
import { ChevronDown, Monitor, Moon, Sun } from 'lucide-react';
import { SettingsRow } from './SettingsRow';
import { SettingsSection } from './SettingsSection';
import { usePwaColorScheme } from '../hooks/usePwaColorScheme';
import type { PwaPreferences } from '../preferences';

export function GeneralSettings({ preferences, onChange }: {
	preferences: PwaPreferences;
	onChange: (patch: Partial<PwaPreferences>) => void;
}) {
	const { themePreference, setThemePreference } = usePwaColorScheme();
	const pointerSelection = useRef(false);
	return <SettingsSection title="General">
		<SettingsRow className="settings-row--theme" title="Theme">
			<div className="settings-theme-picker" role="group" aria-label="Theme">
				{([
					{ value: 'system', label: 'System', icon: Monitor },
					{ value: 'light', label: 'Light', icon: Sun },
					{ value: 'dark', label: 'Dark', icon: Moon },
				] as const).map(({ value, label, icon: Icon }) => <Toggle key={value}
					className={'settings-theme-option' + (themePreference === value ? ' is-active' : '')}
					type="button" data-theme={value} pressed={themePreference === value}
					onPressedChange={() => setThemePreference(value)}><Icon size={15} /><span>{label}</span></Toggle>)}
			</div>
		</SettingsRow>
		<SettingsRow as="label" className="settings-row--preference" title="Open to"
			onPointerDownCapture={() => { pointerSelection.current = true; }}>
			<span className="settings-preference-control settings-preference-control--select">
				<select aria-label="Open to" className="settings-preference-input" value={preferences.defaultScreen}
					onKeyDown={() => { pointerSelection.current = false; }}
					onChange={event => {
						onChange({ defaultScreen: event.currentTarget.value as PwaPreferences['defaultScreen'] });
						if (pointerSelection.current) event.currentTarget.blur();
					}}>
					<option value="today">Today</option>
					<option value="inbox">Inbox</option>
					<option value="upcoming">Upcoming</option>
					<option value="browse">Projects</option>
					<option value="reading">Reading list</option>
					<option value="favorites">Favorites</option>
					<option value="archive">Archive</option>
				</select>
				<ChevronDown size={14} aria-hidden="true" />
			</span>
		</SettingsRow>
	</SettingsSection>;
}
