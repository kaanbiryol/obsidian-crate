import { test } from '@playwright/test';
import { registerReminderSourceIssueTests } from './reminder-source-issues-cases';
test.use({ browserName: 'webkit' });
registerReminderSourceIssueTests();
