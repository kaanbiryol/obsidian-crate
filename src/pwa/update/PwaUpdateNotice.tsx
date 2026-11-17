import { PwaButton } from '../components/PwaButton';
import { useAppUpdate } from './PwaUpdateProvider';

export function PwaUpdateFeedback() {
	const { feedback } = useAppUpdate();
	return feedback && <p className="pwa-update-status" role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p>;
}

/** The only update action. A blocked tap explains why instead of doing nothing. */
export function PwaUpdateButton() {
	const { version, update, updating, launchPending, blockedReason } = useAppUpdate();
	if (!version || launchPending) return null;
	return <PwaButton variant="ghost" size="touch" className="pwa-update-pill"
		disabled={updating} aria-disabled={Boolean(blockedReason)} aria-busy={updating} title={blockedReason ?? undefined}
		aria-label="Update available" onClick={() => void update()}>Update</PwaButton>;
}
