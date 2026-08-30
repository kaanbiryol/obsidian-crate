export function isInitialPwaContentReady({
	authToken,
	bootstrapped,
	loading,
}: {
	authToken: string | null;
	bootstrapped: boolean;
	loading: boolean;
}): boolean {
	return bootstrapped && (!authToken || !loading);
}
