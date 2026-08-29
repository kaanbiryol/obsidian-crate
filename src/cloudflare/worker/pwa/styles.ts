import baseStyles from './styles/base.css?raw-css';
import editorStyles from './styles/editor.css?raw-css';
import remindersViewStyles from './styles/reminders-view.css?raw-css';
import responsiveStyles from './styles/responsive.css?raw-css';
import themeStyles from './styles/theme.css?raw-css';
import sharedRemindersViewStyles from '../../../reminders/ui/reminders-view.scss?raw-css';

const LIGHT_THEME_MEDIA_PREFIX = '@media (prefers-color-scheme: light){';
const lightThemeStart = themeStyles.indexOf(LIGHT_THEME_MEDIA_PREFIX);
const lightThemeEnd = themeStyles.lastIndexOf('}');

if (lightThemeStart < 0 || lightThemeEnd <= lightThemeStart) {
	throw new Error('Missing PWA light theme media block');
}

const baseThemeStyles = themeStyles.slice(0, lightThemeStart);
// Emit the light rules separately so the client can switch their media between system, on, and off.
export const PWA_LIGHT_THEME_STYLES = themeStyles.slice(
	lightThemeStart + LIGHT_THEME_MEDIA_PREFIX.length,
	lightThemeEnd,
);

export const PWA_STYLES = [
	baseStyles,
	sharedRemindersViewStyles,
	remindersViewStyles,
	editorStyles,
	responsiveStyles,
	baseThemeStyles,
].join('');
