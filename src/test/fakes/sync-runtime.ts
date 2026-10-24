/** `SyncRuntime.withCurrentApi` over a test's client getter: rejects when the client is
 * missing or was replaced before `read` settled. */
export function fakeWithCurrentApi<Api>(getApiClient: () => Api | null) {
	return async <T>(read: (api: Api, isCurrent: () => boolean) => Promise<T>, staleMessage: string): Promise<T> => {
		const api = getApiClient();
		if (!api) throw new Error('Sync is not configured.');
		const result = await read(api, () => getApiClient() === api);
		if (getApiClient() !== api) throw new Error(staleMessage);
		return result;
	};
}
