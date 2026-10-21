import { consumeReadingKeyFragment } from './encryption/encryption-fragments';
import { consumeEncryptionFragment } from './encryption/encryption-session';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FeatureShell } from './FeatureShell';
import { PwaLaunchSplash } from './components/PwaChrome';
import { LazyPwaFeature } from './components/LazyPwaFeature';
import { isStandaloneApp } from './config';
import { protectInstalledAppStorage } from './storage/browser-storage';

const loadReminders = () => import('./reminders/RemindersApp').then(module => ({ default: module.RemindersApp }));

consumeReadingKeyFragment();
consumeEncryptionFragment();
const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root');
createRoot(root).render(<FeatureShell reminders={<LazyPwaFeature name="Reminders" load={loadReminders} opening={<PwaLaunchSplash />} />} />);
// Off the startup path: the request only needs to settle before the browser runs short of space.
window.setTimeout(() => { void protectInstalledAppStorage(isStandaloneApp()); }, 0);
