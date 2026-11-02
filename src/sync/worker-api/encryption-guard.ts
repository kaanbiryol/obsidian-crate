/** How long a response saying this vault is not encrypted lets a plaintext mutation skip the probe. */
const ENCRYPTION_OFF_TRUST_MS = 30_000;
/** Refusals that may mean another device turned encryption on and revoked or locked this credential. */
const ENCRYPTION_VERDICT_RESETS = new Set([401, 403, 423, 428]);
/** Unprefixed routes whose mutations carry private settings or reminder folders. */
const PRIVATE_MUTATION_ROUTES = new Set(['/settings', '/notifications/reminders-enrollment-token']);

const isPrivateRoute = (route: string) => ['/sync/', '/reading/', '/reminders/'].some(prefix => route.startsWith(prefix));

/** When a request was dispatched, for `observe` to judge its response. */
export interface DispatchedRequest { at: number; resets: number }

/** Decides when a request without encryption headers must first probe `/encryption`.
 * Another device may have enabled encryption since this client last synced; the server
 * rejects plaintext into an encrypted vault either way, but private paths and bodies
 * should not leave this device until a check or a recent response says encryption is off. */
export class EncryptionDowngradeGuard {
	/** When a request whose response said this vault is not encrypted was dispatched. */
	private offAt: number | null = null;
	/** Bumped whenever that verdict is dropped, so a response already in flight cannot restore it. */
	private resets = 0;
	/** Set while this vault last synced encrypted but holds no keys: an unencrypted
	 * server must not receive private plaintext until the user confirms it. */
	private plaintextRefused = false;
	/** Called whenever an authenticated response reports that this vault is encrypted. */
	private onEncrypted?: () => void;

	refusePlaintext(refused: boolean): void { this.plaintextRefused = refused; }
	refusesPlaintext(): boolean { return this.plaintextRefused; }
	observeEncryption(callback: (() => void) | undefined): void { this.onEncrypted = callback; }

	forget(): void {
		this.offAt = null;
		this.resets++;
	}

	/** A mutation sent without keys to a server that supports encryption, or while
	 * plaintext is refused, probes first unless a recent response confirmed encryption is off. */
	mutationNeedsProbe(path: string, capable: boolean, keyed: boolean, now = performance.now()): boolean {
		const route = path.split('?')[0]!;
		const offConfirmed = !this.plaintextRefused && this.offAt !== null && now - this.offAt < ENCRYPTION_OFF_TRUST_MS;
		return (capable || this.plaintextRefused) && !keyed && !offConfirmed && (isPrivateRoute(route) || PRIVATE_MUTATION_ROUTES.has(route));
	}

	/** While plaintext is refused, reads that send file paths or a search, such as
	 * metadata checks for local paths, probe first too. */
	readNeedsProbe(path: string, method: string | undefined, keyed: boolean): boolean {
		return this.plaintextRefused && !keyed && isPrivateRoute(path.split('?')[0]!)
			&& ((method ?? 'GET').toUpperCase() === 'POST' || /[?&](path|search)=/.test(path));
	}

	dispatched(now = performance.now()): DispatchedRequest {
		return { at: now, resets: this.resets };
	}

	/** Learn from one response's encryption state header and status. */
	observe(encryptionState: string | null, status: number, request: DispatchedRequest): void {
		if (encryptionState === 'on' || ENCRYPTION_VERDICT_RESETS.has(status)) this.forget();
		else if (encryptionState === 'off' && request.resets === this.resets) this.offAt = request.at;
		if (encryptionState === 'on') this.onEncrypted?.();
	}
}
