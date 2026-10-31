import dockStyles from '../../../pwa/styles/dock.scss?raw-css';
import motionStyles from '../../../pwa/styles/motion.scss?raw-css';
import readingStyles from '../../../reading/ui/reading.scss?raw-css';
import readingWebStyles from '../../../pwa/reading/web.scss?raw-css';
import featureSwitcherStyles from '../../../pwa/styles/feature-switcher.scss?raw-css';
import paletteStyles from '../../../pwa/styles/host/palette.scss?raw-css';
import baseStyles from '../../../pwa/styles/host/base.scss?raw-css';
import interactionStyles from '../../../pwa/styles/host/interactions.scss?raw-css';
import foundationStyles from '../../../pwa/styles/foundation.scss?raw-css';
import drawerStyles from '../../../pwa/styles/host/drawer.scss?raw-css';
import editorStyles from '../../../pwa/styles/host/editor.scss?raw-css';
import remindersViewStyles from '../../../pwa/styles/host/reminders-view.scss?raw-css';
import responsiveStyles from '../../../pwa/styles/host/responsive.scss?raw-css';
import themeStyles from '../../../pwa/styles/host/theme.scss?raw-css';
import ios27Styles from '../../../pwa/styles/host/ios27.scss?raw-css';
import lightThemeStyles from '../../../pwa/styles/host/theme-light.scss?raw-css';
import buttonFeedbackStyles from '../../../pwa/styles/button-feedback.scss?raw-css';
import focusStyles from '../../../pwa/styles/host/focus.scss?raw-css';
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
