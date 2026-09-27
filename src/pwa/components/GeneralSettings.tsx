import { Toggle } from '@base-ui/react/toggle';
import { Monitor, Moon, Sun } from 'lucide-react';
import { SettingsRow } from './SettingsRow';
import { SettingsSection } from './SettingsSection';
import { usePwaColorScheme } from '../hooks/usePwaColorScheme';

export function GeneralSettings() {
	const { themePreference, setThemePreference } = usePwaColorScheme();
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
	</SettingsSection>;
}
