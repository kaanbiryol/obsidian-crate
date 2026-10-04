import contract from './shortcut-contract.json';
/** This capture contract evolves independently of the general app protocol. */
export const READING_SHORTCUT_CONTRACT = Object.freeze(contract);
/** Pages offers the verified shortcut download here once published. */
export const READING_SHORTCUT_URL = contract.downloadUrl;
