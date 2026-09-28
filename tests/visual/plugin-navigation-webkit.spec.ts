import { test } from '@playwright/test';
import { registerPluginNavigationTests } from './plugin-navigation-cases';
test.use({ browserName: 'webkit' });
registerPluginNavigationTests();
