import dockStyles from '../../../pwa/styles/dock.scss?raw-css';
import motionStyles from '../../../pwa/styles/motion.scss?raw-css';
import readingStyles from '../../../reading/ui/reading.scss?raw-css';
import readingWebStyles from '../../../pwa/reading/web.scss?raw-css';
import featureSwitcherStyles from '../../../pwa/styles/feature-switcher.scss?raw-css';
import paletteStyles from './styles/palette.css?raw-css';
import baseStyles from './styles/base.css?raw-css';
import interactionStyles from './styles/interactions.css?raw-css';
import foundationStyles from '../../../pwa/styles/foundation.scss?raw-css';
import drawerStyles from './styles/drawer.css?raw-css';
import editorStyles from './styles/editor.css?raw-css';
import remindersViewStyles from './styles/reminders-view.css?raw-css';
import responsiveStyles from './styles/responsive.css?raw-css';
import themeStyles from './styles/theme.css?raw-css';
import ios27Styles from './styles/ios27.css?raw-css';
import lightThemeStyles from './styles/theme-light.css?raw-css';
import buttonFeedbackStyles from '../../../pwa/styles/button-feedback.scss?raw-css';
import focusStyles from './styles/focus.css?raw-css';
import pwaRemindersViewStyles from '../../../pwa/styles/reminders-view.scss?raw-css';

export const PWA_LIGHT_THEME_STYLES = lightThemeStyles;

export const PWA_STYLES = [
	paletteStyles,
	interactionStyles,
	baseStyles,
	readingStyles,
	readingWebStyles,
	foundationStyles,
	pwaRemindersViewStyles,
	remindersViewStyles,
	editorStyles,
	drawerStyles,
	responsiveStyles,
	themeStyles,
	focusStyles,
	featureSwitcherStyles,
	buttonFeedbackStyles,
	motionStyles,
	dockStyles,
	ios27Styles,
].join('');
