import contract from './shortcut-contract.json';
/** This capture contract evolves independently of the general app protocol. */
export const READING_SHORTCUT_CONTRACT = Object.freeze(contract);
/** Pages offers the verified v2 download here once published; v1 remains available to older servers. */
export const READING_SHORTCUT_URL = contract.downloadUrl;
