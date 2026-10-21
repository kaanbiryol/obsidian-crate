// Header names shared by the plugin, PWA and Worker. Headers owned by one format
// live with it: CRATE_PROTOCOL_HEADER, D1_USAGE_HEADER, CRATE_WEB_SESSION_NAME_HEADER
// and the encryption headers in encryption/server-state.

/** Content hash and byte size of a transferred file. */
export const FILE_HASH_HEADER = 'X-File-Hash';
export const FILE_SIZE_HEADER = 'X-File-Size';
/** Upload precondition: the remote hash the client expects, or `absent`. */
export const EXPECTED_HASH_HEADER = 'X-Crate-Expected-Hash';
/** Durable upload operation ID, or comma-separated IDs for a batch. */
export const UPLOAD_OPERATION_HEADER = 'X-Crate-Upload-Operation';
export const UPLOAD_OPERATIONS_HEADER = 'X-Crate-Upload-Operations';
/** File incarnation of an individual download. */
export const REVISION_HEADER = 'X-Crate-Revision';
/** Initial import token. */
export const INITIAL_IMPORT_HEADER = 'X-Crate-Import';
/** Reminder list position a later `since` delta can start from. */
export const DELTA_BASE_HEADER = 'X-Crate-Delta-Base';
/** Diagnostics correlation for the client session, logical operation and server request. */
export const CLIENT_SESSION_HEADER = 'X-Crate-Client-Session';
export const OPERATION_ID_HEADER = 'X-Crate-Operation-Id';
export const REQUEST_ID_HEADER = 'X-Crate-Request-Id';
