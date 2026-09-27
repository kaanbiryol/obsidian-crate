import { RefreshCw } from 'lucide-react';
import { IconButton } from '@/ui/shared/IconButton';
import { PwaButton } from './PwaButton';
import { useAppUpdate } from './PwaUpdateProvider';

/** One quiet, persistent notice, shared by the app chrome and the Settings sheet. */
export function PwaUpdateNotice({ disabled = false }: { disabled?: boolean }) {
	const { version, dismissed, dismiss, updating, update } = useAppUpdate();
	if (!version || dismissed) return null;
	return <div className="pwa-update-notice">
		<RefreshCw size={16} strokeWidth={1.7} aria-hidden="true" />
		<span className="pwa-update-notice__text" role="status">Update available</span>
		<PwaButton variant="ghost" size="touch" className="pwa-update-button" disabled={updating || disabled} aria-busy={updating}
			aria-label="Update to the latest version" onClick={() => void update()}>
			<span className="pwa-update-button__label" aria-hidden={updating}>Refresh</span>
			<span className="pwa-update-button__label pwa-update-button__label--busy" aria-hidden={!updating}>Updating…</span>
		</PwaButton>
		<IconButton icon="x" label="Dismiss update notice" size="large" iconSize="s" disabled={updating || disabled} onClick={dismiss} />
	</div>;
}
