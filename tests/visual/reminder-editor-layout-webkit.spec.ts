import { test } from '@playwright/test';
import { registerReminderEditorLayoutTests } from './reminder-editor-layout-cases';

test.use({ browserName: 'webkit' });
registerReminderEditorLayoutTests();
