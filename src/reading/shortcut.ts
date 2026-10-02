import contract from './shortcut-contract.json';
/** This capture contract evolves independently of the general app protocol. */
export const READING_SHORTCUT_CONTRACT = Object.freeze(contract);
/** Published by the Pages workflow; v2 keeps saved URLs in a browser-only fragment; preserve v1 for older servers. */
export const READING_SHORTCUT_URL = 'https://crate.kaanbiryol.com/shortcuts/v2/Save%20to%20Crate%20(iOS%2027).shortcut';
