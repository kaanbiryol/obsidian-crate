// RFC 8291: 4096 total bytes minus 86 header, 16 authentication tag and
// one final-record delimiter. Budget the serialized JSON, including escapes.
export const MAX_PUSH_PAYLOAD_BYTES = 3993;
export class PushPayloadError extends Error {}

export function fitPushDisplay<T extends { notification: { title: string; body: string } }>(payload: T): T {
	const encoder = new TextEncoder();
	const size = () => encoder.encode(JSON.stringify(payload)).byteLength;
	for (const field of ['body', 'title'] as const) {
		if (size() <= MAX_PUSH_PAYLOAD_BYTES) return payload;
		const points = Array.from(payload.notification[field]);
		let low = 0;
		let high = points.length;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			payload.notification[field] = points.slice(0, mid).join('') + '…';
			if (size() <= MAX_PUSH_PAYLOAD_BYTES) low = mid;
			else high = mid - 1;
		}
		payload.notification[field] = points.slice(0, low).join('') + '…';
	}
	if (size() > MAX_PUSH_PAYLOAD_BYTES) throw new PushPayloadError('Notification identifiers exceed the Web Push payload limit');
	return payload;
}
