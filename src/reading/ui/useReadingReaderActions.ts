import { useCallback, useLayoutEffect, useMemo, useState } from 'react';

type ActionKind = 'mutation' | 'share';
interface ActionState { busy: boolean; sharing: boolean; copied: boolean; error: string | null }
const idle: ActionState = { busy: false, sharing: false, copied: false, error: null };

/** Article actions can finish after navigation; only their originating reader publishes feedback. */
export function useReadingReaderActions(articleId: string) {
	const lifetime = useMemo(() => ({
		articleId,
		active: false,
		pending: { mutation: false, share: false },
		copyTimer: undefined as { window: Window; id: number } | undefined,
	}), [articleId]);
	const [state, setState] = useState({ lifetime, ...idle });
	const clearCopyTimer = () => {
		if (lifetime.copyTimer) lifetime.copyTimer.window.clearTimeout(lifetime.copyTimer.id);
		lifetime.copyTimer = undefined;
	};
	useLayoutEffect(() => {
		lifetime.active = true;
		return () => {
			lifetime.active = false;
			if (lifetime.copyTimer) lifetime.copyTimer.window.clearTimeout(lifetime.copyTimer.id);
			lifetime.copyTimer = undefined;
		};
	}, [lifetime]);
	const publish = useCallback((next: Partial<ActionState>) => {
		if (lifetime.active) setState(previous => ({ ...(previous.lifetime === lifetime ? previous : idle), lifetime, ...next }));
	}, [lifetime]);
	const setError = useCallback((error: string | null) => publish({ error }), [publish]);
	const runAction = async (kind: ActionKind, action: (isCurrent: () => boolean) => Promise<void>) => {
		if (!lifetime.active || lifetime.pending[kind]) return;
		lifetime.pending[kind] = true;
		publish({ [kind === 'share' ? 'sharing' : 'busy']: true, error: null });
		try { await action(() => lifetime.active); }
		catch (cause) { publish({ error: cause instanceof Error ? cause.message : 'Could not update this article.' }); }
		finally {
			lifetime.pending[kind] = false;
			publish({ [kind === 'share' ? 'sharing' : 'busy']: false });
		}
	};
	const shareLink = async (ownerWindow: Window | null | undefined, title: string, url: string) => {
		if (!ownerWindow) return;
		await runAction('share', async isCurrent => {
			try {
				const navigator = ownerWindow.navigator;
				if (navigator.share) await navigator.share({ title, url });
				else {
					await navigator.clipboard.writeText(url);
					if (!isCurrent()) return;
					publish({ copied: true });
					clearCopyTimer();
					lifetime.copyTimer = { window: ownerWindow, id: ownerWindow.setTimeout(() => {
						lifetime.copyTimer = undefined;
						publish({ copied: false });
					}, 2500) };
				}
			} catch (cause) { if (!(cause instanceof Error && cause.name === 'AbortError')) throw cause; }
		});
	};
	const { busy, sharing, copied, error } = state.lifetime === lifetime ? state : idle;
	return {
		busy, sharing, copied, error,
		run: (action: (isCurrent: () => boolean) => Promise<void>) => runAction('mutation', action),
		setError,
		shareLink,
	};
}
