import type { ComponentProps } from 'react';
import { ListStyleSetting } from './ListStyleSetting';
import { Button } from '@/ui/shared/Button';
import { Monitor, Moon, Sun } from 'lucide-react';
import { SettingsRow } from './SettingsRow';
import { SettingsSection } from './SettingsSection';
import { usePwaColorScheme } from '../hooks/usePwaColorScheme';

export function GeneralSettings(props: ComponentProps<typeof ListStyleSetting>) {
	const { themePreference, setThemePreference } = usePwaColorScheme();
	return <SettingsSection title="General">
		<SettingsRow className="settings-row--theme" title="Theme">
			<div className="settings-theme-picker" role="group" aria-label="Theme">
				{([
					{ value: 'system', label: 'System', icon: Monitor },
					{ value: 'light', label: 'Light', icon: Sun },
					{ value: 'dark', label: 'Dark', icon: Moon },
				] as const).map(({ value, label, icon: Icon }) => <Button key={value}
					className={'settings-theme-option' + (themePreference === value ? ' is-active' : '')}
					type="button" data-theme={value} aria-pressed={themePreference === value}
					onClick={() => setThemePreference(value)}><Icon size={15} aria-hidden="true" /><span>{label}</span></Button>)}
			</div>
		</SettingsRow>
		<ListStyleSetting {...props} />
	</SettingsSection>;
}
