import { LazyPwaFeature } from '../components/LazyPwaFeature';
import { ReadingOpening } from './ReadingOpening';

const load = () => import('./App');
export function ReadingFeature() {
	return <LazyPwaFeature name="Reading" load={load} opening={<ReadingOpening />} />;
}
