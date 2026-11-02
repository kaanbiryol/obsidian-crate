import { createRandomHexToken } from '../platform/random-hex';
import { sha256Hex } from '../platform/sha256';

/** Device credentials for a newly connected server; a seam for credential tests. */
export const generateSecureToken = (): string => createRandomHexToken();
export const hashToken = (token: string): Promise<string> => sha256Hex(token);
