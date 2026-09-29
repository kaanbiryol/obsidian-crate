import React from 'react';
import { createRoot } from 'react-dom/client';
import { FeatureShell } from './FeatureShell';
import { RemindersApp } from './components/RemindersApp';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root');
createRoot(root).render(<FeatureShell reminders={<RemindersApp />} />);
