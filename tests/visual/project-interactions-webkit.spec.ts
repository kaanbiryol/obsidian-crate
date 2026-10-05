import { test } from '@playwright/test';
import { registerProjectInteractionTests } from './project-interactions-cases';

test.use({ browserName: 'webkit' });
registerProjectInteractionTests();
