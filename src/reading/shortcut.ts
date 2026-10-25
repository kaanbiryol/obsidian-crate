import contract from './shortcut-contract.json';
/** This capture contract evolves independently of the general app protocol. */
export const READING_SHORTCUT_CONTRACT = Object.freeze(contract);
/** Pages offers the verified shortcut download here once published. */
export const READING_SHORTCUT_URL = contract.downloadUrl;
/** Development Workers offer the shortcut signed from the working tree here.
 * Outside the PWA scope, so iOS opens it in a browser sheet that can be closed. */
export const DEVELOPMENT_SHORTCUT_PATH = '/shortcuts/development/';
export const DEVELOPMENT_SHORTCUT_FILE_PATH = '/shortcuts/development/Save%20to%20Crate.shortcut';
