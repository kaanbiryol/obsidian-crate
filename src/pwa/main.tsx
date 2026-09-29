import React from 'react';
import { createRoot } from 'react-dom/client';
import { FeatureShell } from './FeatureShell';
import { PwaLaunchSplash } from './components/PwaChrome';
import { LazyPwaFeature } from './components/LazyPwaFeature';

const loadReminders = () => import('./components/RemindersApp').then(module => ({ default: module.RemindersApp }));

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root');
createRoot(root).render(<FeatureShell reminders={<LazyPwaFeature name="Reminders" load={loadReminders} opening={<PwaLaunchSplash />} />} />);
