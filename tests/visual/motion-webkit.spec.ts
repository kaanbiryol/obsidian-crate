import { test } from '@playwright/test';
import { registerMotionTests } from './motion-cases';
test.use({ browserName: 'webkit' });
registerMotionTests();
