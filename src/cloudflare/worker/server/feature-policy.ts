import { parseFeaturePolicy, type FeaturePolicy } from '../../../protocol/feature-policy';
import { readServerState } from '../d1/server-state';

export async function featurePolicy(db: D1Database): Promise<FeaturePolicy> {
	return parseStoredFeaturePolicy(await readServerState(db, 'features'));
}
/** Parses a stored policy value; authentication loads it with the token. */
export function parseStoredFeaturePolicy(stored: string | null): FeaturePolicy {
	if (stored === null) return { reading: true, reminders: true, revision: null };
	const value = parseFeaturePolicy(JSON.parse(stored));
	// Saved policies always carry a revision.
	if (!value || value.revision === null) throw new Error('Invalid feature policy');
	return value;
}
export async function featureEnabled(db: D1Database, feature: 'reading' | 'reminders'): Promise<boolean> {
	return (await featurePolicy(db))[feature];
}
