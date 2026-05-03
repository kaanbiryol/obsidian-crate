import { BASE_STYLES } from './styles/base';
import { EDITOR_STYLES } from './styles/editor';
import { REMINDERS_VIEW_STYLES } from './styles/reminders-view';
import { RESPONSIVE_STYLES } from './styles/responsive';

export const PWA_STYLES = [
	BASE_STYLES,
	REMINDERS_VIEW_STYLES,
	EDITOR_STYLES,
	RESPONSIVE_STYLES,
].join('');
