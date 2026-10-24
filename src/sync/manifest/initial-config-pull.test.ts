import { expect, it } from 'vitest';
import { parseInitialConfigPull } from './initial-config-pull';

const settingsPath = '.obsidian/appearance.json';

it.each([null, {}, { configDir: '../outside', files: {} }, { configDir: '.obsidian', files: { 'note.md': 'a'.repeat(64) } },
	{ configDir: '.obsidian', files: { [settingsPath]: 'invalid' } }])('rejects malformed initial pull authority: %j', value => {
	expect(() => parseInitialConfigPull(value)).toThrow('Invalid initial settings pull checkpoint');
});
