import { Fragment } from 'react';
import { SettingsRow } from '../settings/SettingsRow';
import { earlierReadingChanges, removeEarlierReadingChanges } from './storage/storage';
import { ReviewedReadingRemoval } from './ReviewedReadingRemoval';
import { removeReviewedReading } from './outbox';
import type { useReadingSession } from './useReadingSession';

type ReadingIssuesSession = Pick<ReturnType<typeof useReadingSession>, 'session' | 'pending' | 'recovery' | 'refreshRecovery' | 'publishPending'>;

/** Settings rows for Reading changes that could not sync, with reviewed removal. */
export function ReadingSettingsIssues({ connection }: { connection: ReadingIssuesSession }) {
	const { session, pending, recovery } = connection;
	return <>
		{recovery && <>
			<SettingsRow title="Earlier changes need review" description="Changes from an earlier sign-in are still stored on this device." />
			<ReviewedReadingRemoval fileName="crate-reading-earlier-changes.json" exportLabel="Export earlier changes"
				load={() => earlierReadingChanges(session?.id)}
				onRemove={async exported => {
					const removed = await removeEarlierReadingChanges(session?.id, exported);
					await connection.refreshRecovery();
					return removed;
				}} />
		</>}
		{pending.filter(op => op.error || op.review).map(op => <Fragment key={op.id}>
			<SettingsRow title={op.review ? 'Change needs review' : 'Couldn’t sync'} description={op.error || 'This change is still stored on this device.'} />
			{op.review && session && <ReviewedReadingRemoval fileName="crate-reading-change.json" exportLabel="Export change"
				load={async () => op}
				onRemove={async exported => {
					const next = await removeReviewedReading(session, op.id, exported);
					if (next) connection.publishPending(session, next);
					return next !== null;
				}} />}
		</Fragment>)}
	</>;
}
