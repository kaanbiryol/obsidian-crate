import type CratePlugin from '../plugin/CratePlugin';
import { captureSyncApiConnection, serverRequest } from '../plugin/server-request';
import { isRecord } from '../platform/validation';
import { parseReadingPolicy, type ReadingPolicy, type ReadingPolicyUpdate } from '../protocol/reading-policy';
import { SECRET_KEYS } from '../platform/secret-keys';

type SyncApiConnection = ReturnType<typeof captureSyncApiConnection>;

/** `/reading/policy` responds with `{ policy }`, which is null before Reading is set up.
 * An encrypted vault names the folder by its tag; the result uses the plaintext folder. */
async function responsePolicy({ api, assertCurrent }: SyncApiConnection, response: unknown): Promise<ReadingPolicy | null> {
	assertCurrent();
	const value = isRecord(response) ? response.policy : undefined;
	if (value === null) return null;
	const policy = parseReadingPolicy(value);
	if (!policy) throw new Error('Could not read Reading settings.');
	const { folder_label: label, ...plain } = policy;
	if (label === undefined) return plain;
	if (!api) throw new Error('Connect sync to read encrypted Reading settings.');
	const folderPath = await api.localFolder(policy.folder_path, label);
	assertCurrent();
	return { ...plain, folder_path: folderPath };
}
export async function readReadingPolicy(plugin: CratePlugin): Promise<ReadingPolicy | null> {
	const connection = captureSyncApiConnection(plugin);
	return responsePolicy(connection, await serverRequest<unknown>(plugin, '/reading/policy'));
}
export async function writeReadingPolicy(plugin: CratePlugin, update: ReadingPolicyUpdate): Promise<ReadingPolicy> {
	const connection = captureSyncApiConnection(plugin);
	// With saved keys the folder is sent only as its tag, never under its readable name,
	// including after an encryption reset whose upload has not finished.
	if (!connection.api?.isEncrypted() && plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_KEYS)) {
		throw new Error('Encrypted sync is not ready on this device. Finish or resume encryption setup in Manage encryption, then try again.');
	}
	const folder = await connection.api?.serverFolder(update.folderPath) ?? { folderPath: update.folderPath };
	connection.assertCurrent();
	const policy = await responsePolicy(connection, await serverRequest<unknown>(plugin, '/reading/policy', { ...update, ...folder }));
	if (!policy) throw new Error('Could not read Reading settings.');
	return policy;
}
