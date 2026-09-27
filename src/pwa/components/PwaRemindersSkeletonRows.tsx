import React from 'react';
import { PWA_REMINDER_SKELETON_HTML } from '../opening-screen';

export function PwaRemindersSkeletonRows() {
	return <div className="pwa-reminders-skeleton" role="status" aria-label="Loading reminders" dangerouslySetInnerHTML={{ __html: PWA_REMINDER_SKELETON_HTML }} />;
}
