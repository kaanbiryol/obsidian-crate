import readingStyles from '../../../reading/ui/reading.scss?raw-css';
import readingWebStyles from '../../../pwa/reading/web.scss?raw-css';
import featureSwitcherStyles from '../../../pwa/styles/feature-switcher.scss?raw-css';
import baseStyles from './styles/base.css?raw-css';
import drawerStyles from './styles/drawer.css?raw-css';
import editorStyles from './styles/editor.css?raw-css';
import remindersViewStyles from './styles/reminders-view.css?raw-css';
import responsiveStyles from './styles/responsive.css?raw-css';
import themeStyles from './styles/theme.css?raw-css';
import lightThemeStyles from './styles/theme-light.css?raw-css';
import buttonFeedbackStyles from '../../../pwa/styles/button-feedback.scss?raw-css';
import focusStyles from './styles/focus.css?raw-css';
import pwaRemindersViewStyles from '../../../pwa/styles/reminders-view.scss?raw-css';

export const PWA_LIGHT_THEME_STYLES = lightThemeStyles;

export const PWA_STYLES = [
	baseStyles,
 readingStyles, readingWebStyles,
	pwaRemindersViewStyles,
	remindersViewStyles,
	editorStyles,
	drawerStyles,
	responsiveStyles,
	themeStyles,
	focusStyles,
	featureSwitcherStyles,
	buttonFeedbackStyles,
].join('');
