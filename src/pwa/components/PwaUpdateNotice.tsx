import { PwaButton } from './PwaButton';
import { SettingsRow } from './SettingsRow';
import { useAppUpdate } from './PwaUpdateProvider';

function UpdateAction({ disabled = false }: { disabled?: boolean }) {
	const { updating, update, blockedReason } = useAppUpdate();
	return <PwaButton variant="primary" size="touch" className="pwa-update-button" disabled={updating || disabled || Boolean(blockedReason)} aria-busy={updating}
		aria-label="Update to the latest version" onClick={() => void update()}>
		<span className="pwa-update-button__label" aria-hidden={updating}>Update</span>
		<span className="pwa-update-button__label pwa-update-button__label--busy" aria-hidden={!updating}>Updating…</span>
	</PwaButton>;
}

export function PwaUpdateFeedback() {
	const { feedback } = useAppUpdate();
	return feedback && <p className="pwa-update-status" role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p>;
}

/** Settings offers the same direct update action as the header. */
export function PwaUpdateNotice({ disabled = false }: { disabled?: boolean }) {
	const { version, blockedReason } = useAppUpdate();
	if (!version) return null;
	return <SettingsRow className="pwa-update-notice" title="Update available"
		description={blockedReason ?? 'Crate will reload to apply the update.'}>
		<UpdateAction disabled={disabled} />
	</SettingsRow>;
}

export function PwaUpdateButton() {
	const { version, update, updating, launchPending, blockedReason } = useAppUpdate();
	if (!version || launchPending) return null;
	return <PwaButton variant="ghost" size="touch" className="pwa-update-pill"
		disabled={updating || Boolean(blockedReason)} aria-busy={updating} title={blockedReason ?? undefined}
		aria-label="Update available" onClick={() => void update()}>Update</PwaButton>;
}
