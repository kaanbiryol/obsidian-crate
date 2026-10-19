/**
 * Maps values with at most `limit` operations in flight. Results keep input
 * order; after a failure, no further operations start.
 */
export async function mapBounded<T, R>(values: readonly T[], limit: number, map: (value: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(values.length);
	let next = 0, failed = false;
	const worker = async () => {
		while (!failed && next < values.length) {
			const index = next++;
			try { results[index] = await map(values[index]!); } catch (error) { failed = true; throw error; }
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
	return results;
}
