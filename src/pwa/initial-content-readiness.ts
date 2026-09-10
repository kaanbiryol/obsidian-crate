export function isInitialPwaContentReady({
	authToken,
	bootstrapped,
	loading,
	notificationPromptReady = true,
	pendingChangesReady = true,
}: {
	authToken: string | null;
	bootstrapped: boolean;
	loading: boolean;
	notificationPromptReady?: boolean;
	pendingChangesReady?: boolean;
}): boolean {
	return bootstrapped && (!authToken || (!loading && notificationPromptReady && pendingChangesReady));
}
