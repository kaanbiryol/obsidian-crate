export function isInitialPwaContentReady({
	authToken,
	bootstrapped,
	loading,
	notificationPromptReady = true,
}: {
	authToken: string | null;
	bootstrapped: boolean;
	loading: boolean;
	notificationPromptReady?: boolean;
}): boolean {
	return bootstrapped && (!authToken || (!loading && notificationPromptReady));
}
