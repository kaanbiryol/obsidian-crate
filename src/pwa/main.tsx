import { consumeReadingKeyFragment } from './encryption/encryption-fragments';
import { consumeReminderEncryptionFragment } from './reminders/encryption-session';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FeatureShell } from './FeatureShell';
import { RemindersApp } from './reminders/RemindersApp';
import { isStandaloneApp } from './config';
import { protectInstalledAppStorage } from './storage/browser-storage';

consumeReadingKeyFragment();
consumeReminderEncryptionFragment();
const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root');
createRoot(root).render(<FeatureShell reminders={<RemindersApp />} />);
// Off the startup path: the request only needs to settle before the browser runs short of space.
window.setTimeout(() => { void protectInstalledAppStorage(isStandaloneApp()); }, 0);
