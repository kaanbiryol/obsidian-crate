// Terminal emphasis for interactive output. Logs, pipes and NO_COLOR stay plain text,
// so log followers and tests match the same words.
const styled = Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env);

/** @param {number} open @param {number} close */
const style = (open, close) => (/** @type {string} */ text) => styled ? `\x1b[${open}m${text}\x1b[${close}m` : text;

export const bold = style(1, 22);
export const dim = style(2, 22);
export const green = style(32, 39);
