import baseStyles from './styles/base.css?raw-css';
import editorStyles from './styles/editor.css?raw-css';
import remindersViewStyles from './styles/reminders-view.css?raw-css';
import responsiveStyles from './styles/responsive.css?raw-css';
import themeStyles from './styles/theme.css?raw-css';
import sharedRemindersViewStyles from '../../../reminders/ui/reminders-view.scss?raw-css';

export const PWA_STYLES = [
	baseStyles,
	sharedRemindersViewStyles,
	remindersViewStyles,
	editorStyles,
	responsiveStyles,
	themeStyles,
].join('');
