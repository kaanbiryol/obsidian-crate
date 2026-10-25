import { expect, it } from 'vitest';
import { PathTags } from './path-tags';
import { resolveEncryptedPath } from './path-binding';
import { openFolderLabel, sealFolderLabel } from './folder-label';
import { importEncryptionSecret } from './envelope';
import { createOpaqueWireName, encodeBase32, isWirePath, isWireSegment } from '../protocol/encrypted-path';

const vaultId = '0b8e2f9c-4c7a-4d3e-9a51-2f6c1d8e7b40';
const secret = { id: 'b4d0c0de-0000-4000-8000-000000000001', secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' };
const tags = () => PathTags.fromSecret(vaultId, secret);

it('encodes RFC 4648 base32 in lowercase without padding', () => {
	expect(encodeBase32(new TextEncoder().encode('foobar'))).toBe('mzxw6ytboi');
	expect(encodeBase32(new Uint8Array(16))).toHaveLength(26);
});

it('keeps tags stable across releases', async () => {
	// The server stores these forever: a change here orphans every encrypted vault.
	const t = await tags();
	expect(await t.wire('Reading')).toBe(await t.wire('Reading'));
	expect(await t.wire('Reading/Note.md')).toMatchInlineSnapshot(`"sq4ev7z6rjb3quybnf4pyskyuy/5glnuqh4wczyahq7ws2vqm3psq.md"`);
});

it('gives case and Unicode variants one identity and keeps parents, folders and Markdown rules', async () => {
	const t = await tags();
	const wire = await t.wire('Reading/Café.md');
	expect(isWirePath(wire)).toBe(true);
	expect(wire).toMatch(/^[a-z2-7]{26}\/[a-z2-7]{26}\.md$/);
	expect(await t.wire('reading/CAFÉ.MD')).toBe(wire);
	const [folder] = wire.split('/');
	expect(await t.wire('Reading')).toBe(folder);
	expect((await t.wire('Reading/Sub/Note.md')).startsWith(`${folder}/`)).toBe(true);
	expect((await t.wire('Archive/Café.md')).split('/')[1]).not.toBe(wire.split('/')[1]);
	expect(await t.wire('Reading/image.png')).toMatch(/\/[a-z2-7]{26}$/);
	// A folder and a file of the same name share a tag, so the server still sees the clash.
	expect((await t.wire('Reading/Café.md/inner.md')).startsWith(`${wire}/`)).toBe(true);
	const other = await PathTags.fromSecret(vaultId, { ...secret, secret: 'AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' });
	expect(await other.wire('Reading/Café.md')).not.toBe(wire);
});

it('rejects paths nested too deeply for the server limit', async () => {
	await expect((await tags()).wire(Array.from({ length: 40 }, (_, index) => `f${index}`).join('/'))).rejects.toThrow('nested too deeply');
});

it('binds metadata paths to their server path and accepts random names only for notes created without the key', async () => {
	const t = await tags();
	const readingWire = await t.wire('Reading'), reading = { plain: 'Reading', wire: readingWire };
	const opaque = `${readingWire}/${createOpaqueWireName()}`;
	expect(isWireSegment(opaque.split('/')[1]!)).toBe(true);
	expect(await resolveEncryptedPath(t, await t.wire('Reading/Note.md'), 'Reading/Note.md', false, reading)).toBe('Reading/Note.md');
	expect(await resolveEncryptedPath(t, opaque, `${readingWire}/Title - site - a1b2c3d4.md`, true, reading)).toBe('Reading/Title - site - a1b2c3d4.md');
	// After an edit the note is re-saved with the vault key and keeps its server name.
	expect(await resolveEncryptedPath(t, opaque, 'Reading/Title - site - a1b2c3d4.md', false, reading)).toBe('Reading/Title - site - a1b2c3d4.md');
	for (const [wire, path, sealed] of [
		[await t.wire('Reading/Note.md'), 'Archive/Note.md', false],
		[await t.wire('Reading/Note.png'), 'Reading/Other.png', false],
		[opaque, `${readingWire}/Title.md`, false],
		[opaque, `${readingWire}/../Escape.md`, true],
		[opaque, `${readingWire}/Image.png`, true],
		[opaque, 'Archive/Title.md', false],
		[await t.wire('Reading/Note.md'), 'Reading/Note.md', true],
		[opaque, 'Reading/Title.md', true],
		[`${await t.wire('Archive')}/${createOpaqueWireName()}`, `${readingWire}/Title.md`, true],
	] as const) await expect(resolveEncryptedPath(t, wire, path, sealed, reading)).rejects.toThrow('does not match');
});

it('recovers plaintext folder names only from a label for the same folder', async () => {
	const t = await tags(), key = await importEncryptionSecret(secret);
	const { wire, label } = await sealFolderLabel('Notes/Reading', t, key, vaultId);
	expect(await openFolderLabel(wire, label, t, key, vaultId)).toBe('Notes/Reading');
	await expect(openFolderLabel(await t.wire('Reminders'), label, t, key, vaultId)).rejects.toThrow('does not match');
});
