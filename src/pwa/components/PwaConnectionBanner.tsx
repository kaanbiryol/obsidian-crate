import { CloudOff } from 'lucide-react';
import { ENCRYPTION_UNVERIFIED } from '../encryption/encryption-verification';

/** A server refusal (forbidden, reset in progress, rate limited) keeps its reason;
 * an unanswered check is only a connection problem. */
export function connectionIssueReason(message: string | null): string | null {
	return message && message !== ENCRYPTION_UNVERIFIED ? message : null;
}

/** The one place a feature says it is offline or could not reach Crate. */
export function PwaConnectionBanner({ text, onRetry, retrying = false }: {
	text: string;
	/** Omitted while the device is offline: retrying cannot help. */
	onRetry?: () => void;
	retrying?: boolean;
}) {
	return <div className="pwa-connection-banner" role="status">
		<CloudOff className="pwa-connection-banner__icon" size={14} aria-hidden="true" />
		<span className="pwa-connection-banner__copy">{text}</span>
		{onRetry && <button className="pwa-connection-banner__retry" type="button" disabled={retrying} onClick={onRetry}>Retry</button>}
	</div>;
}
