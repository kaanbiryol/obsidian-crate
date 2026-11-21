// Terminal QR codes for pairing links: two module rows per text line, drawn with
// half blocks, inside the quiet zone scanners need.
import { pathToFileURL } from 'node:url';
import { qrcodeModule } from './assets.mjs';

/** @type {(typeNumber: number, level: string) => { addData(data: string): void, make(): void, getModuleCount(): number, isDark(row: number, col: number): boolean }} */
const qrcode = (await import(pathToFileURL(qrcodeModule).href)).default;
const QUIET = 2;
// The Worker page that hands a code to Obsidian; DEVICE_PAIRING_PAGE in src/protocol/device-pairing.ts.
const PAIRING_PAGE = '/notifications/pair';

/** The code stays in the fragment, which browsers never send to the server.
 * @param {string} origin @param {string} code */
export const pairingLink = (origin, code) => `${new URL(origin).origin}${PAIRING_PAGE}#${code}`;

/** @param {string} text @returns {string} */
export function terminalQr(text) {
	const qr = qrcode(0, 'L');
	qr.addData(text);
	qr.make();
	const size = qr.getModuleCount();
	const dark = (/** @type {number} */ row, /** @type {number} */ col) => row >= 0 && col >= 0 && row < size && col < size && qr.isDark(row, col);
	const lines = [];
	// Light modules print as blocks, so the code reads on dark and light terminals alike.
	for (let row = -QUIET; row < size + QUIET; row += 2) {
		let line = '';
		for (let col = -QUIET; col < size + QUIET; col++) {
			const top = !dark(row, col), bottom = !dark(row + 1, col);
			line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
		}
		lines.push(line);
	}
	return lines.join('\n');
}
