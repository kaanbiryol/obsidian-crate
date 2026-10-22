import { featureLoader, LazyPwaFeature } from '../components/LazyPwaFeature';
import { ReadingOpening } from './ReadingOpening';

export const readingFeature = featureLoader(() => import('./App'));
export function ReadingFeature() {
	return <LazyPwaFeature name="Reading" feature={readingFeature} opening={<ReadingOpening />} />;
}
