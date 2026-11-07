import { handleReadingRoute as dispatchReadingRoute } from '../routes/reading';
import { ReadingError } from '../reading/common';

/** The Reading dispatcher with the request handler's ReadingError mapping, for tests that call it directly. */
export const handleReadingRoute: typeof dispatchReadingRoute = async (...args) => {
	try { return await dispatchReadingRoute(...args); }
	catch (error) {
		if (error instanceof ReadingError) return error.toResponse();
		throw error;
	}
};
