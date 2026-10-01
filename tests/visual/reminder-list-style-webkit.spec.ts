import { test } from '@playwright/test';
import { reminderListStyleCases } from './reminder-list-style-cases';

test.use({ browserName: 'webkit' });
reminderListStyleCases();
