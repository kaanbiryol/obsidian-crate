import { test } from '@playwright/test';
import { registerControlTests } from './controls-cases';

test.use({ browserName: 'webkit' });
registerControlTests();
