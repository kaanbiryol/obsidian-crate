/** IndexedDB keys in the Reading store. Session migration derives from this list,
 * so a new namespace cannot be skipped silently. */
export const readingKeys = {
	draft: (sessionId: string) => `draft:${sessionId}`,
	pending: (sessionId: string) => `pending:${sessionId}`,
	articlePrefix: (sessionId: string) => `article:${sessionId}:`,
	attemptPrefix: (sessionId: string) => `attempt:${sessionId}:`,
	share: (id: string) => `share:${id}`,
};

export const isPendingReadingKey = (key: string) => key.startsWith('pending:');
/** An offline article copy from any session. */
export const isArticleReadingKey = (key: string) => key.startsWith('article:');

/** Records written for one Reading session, plus shared incoming shares. */
export function isSessionReadingKey(key: string, sessionId: string): boolean {
	return [readingKeys.draft, readingKeys.pending].some(build => key === build(sessionId))
		|| key.startsWith(readingKeys.articlePrefix(sessionId)) || key.startsWith(readingKeys.attemptPrefix(sessionId))
		|| key.startsWith('share:');
}
