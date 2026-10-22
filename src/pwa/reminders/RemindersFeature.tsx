import { featureLoader, LazyPwaFeature } from '../components/LazyPwaFeature';
import { PwaLaunchSplash } from '../components/PwaChrome';

export const remindersFeature = featureLoader(() => import('./RemindersApp').then(module => ({ default: module.RemindersApp })));
export function RemindersFeature() {
	return <LazyPwaFeature name="Reminders" feature={remindersFeature} opening={<PwaLaunchSplash />} />;
}
