import contract from './shortcut-contract.json';
/** This capture contract evolves independently of the general app protocol. */
export const READING_SHORTCUT_CONTRACT = Object.freeze(contract);
/** Published by the Pages workflow; keep v1 available for installed servers. */
export const READING_SHORTCUT_URL = contract.downloadUrl;
