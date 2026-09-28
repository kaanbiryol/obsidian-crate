import { test } from '@playwright/test';
import { registerReadingHighlightTests } from './reading-highlight-cases';
test.use({ browserName: 'webkit' });
registerReadingHighlightTests();
