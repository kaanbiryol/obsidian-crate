import { connectionIssueReason } from '../components/PwaConnectionBanner';

export interface ReadingConnectionInput {
	isOffline: boolean;
	/** An unanswered encryption check: no library page loads and nothing saves. */
	readOnly: boolean;
	hasSession: boolean;
	/** The first inbox page loaded. */
	hasCache: boolean;
	error: string | null;
	connectionState: string;
}

export interface ReadingConnectionView {
	/** The library shows the articles saved on this device instead of the server's pages. */
	savedOnly: boolean;
	/** No Reading folder is connected. */
	readingDisabled: boolean;
	/** The one banner for offline, an unanswered encryption check and a library that never loaded. */
	connectionText: string | null;
	/** Shown in the library when it could not load and no banner explains why. */
	libraryError: string | null;
}

/** What the Reading web app shows for its connection, from the state the runtime reports. */
export function readingConnectionView({ isOffline, readOnly, hasSession, hasCache, error, connectionState }: ReadingConnectionInput): ReadingConnectionView {
	const readingDisabled = !hasSession && connectionState !== 'available';
	// A request that failed on a network the browser still reports as online shows saved articles too.
	const neverLoaded = hasSession && !hasCache && !!error;
	const savedOnly = isOffline || readOnly || neverLoaded;
	const connectionText = readingDisabled ? null
		: isOffline && (hasSession || readOnly) ? 'Offline · showing saved articles'
		: readOnly || neverLoaded ? (readOnly && connectionIssueReason(error)) || 'Couldn’t connect · showing saved articles'
		: null;
	const libraryError = !readingDisabled && !connectionText && !hasCache && error ? 'Your library is unavailable. Retry when connected.' : null;
	return { savedOnly, readingDisabled, connectionText, libraryError };
}
