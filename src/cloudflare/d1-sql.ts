/** Quotes any SQLite identifier, including write-guard trigger names. */
export const quoteName = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** Writes a value as an SQL literal for statements sent through the D1 query API. */
export const literal = (value: unknown): string => value === null ? 'NULL' : typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : (() => { throw new Error('Unsupported database value in upgrade checkpoint'); })();
