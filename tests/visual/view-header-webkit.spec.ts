import { test } from '@playwright/test';
import { registerViewHeaderTests } from './view-header-cases';
test.use({ browserName: 'webkit' });
registerViewHeaderTests();
