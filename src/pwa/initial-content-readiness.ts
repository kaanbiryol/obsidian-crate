export function isInitialPwaContentReady({
	authToken,
	bootstrapped,
	loading,
	pushStateReady,
}: {
	authToken: string | null;
	bootstrapped: boolean;
	loading: boolean;
	pushStateReady: boolean;
}): boolean {
	return bootstrapped && (!authToken || (!loading && pushStateReady));
}
