import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readingShortcutWithFirstRunSetup } from './reading-shortcut-first-run.mjs';

if (process.platform !== 'darwin') throw new Error('Sign this release asset on macOS with Apple Shortcuts installed.');
const manualSetup = process.argv.includes('--manual-setup');
const firstRunSetup = process.argv.includes('--first-run-setup');
if (manualSetup && firstRunSetup) throw new Error('Choose one setup variant.');
const name = firstRunSetup ? 'Save to Crate (iOS 27)' : manualSetup ? 'Save to Crate (manual setup)' : 'Save to Crate';
const temporary = await mkdtemp(join(tmpdir(), 'crate-shortcut-'));
try {
  const input = join(temporary, `${name}.shortcut`);
  await copyFile(new URL('../docs/shortcuts/save-to-crate.plist', import.meta.url), input);
  await mkdir('dist', { recursive: true });
  // Provide an editor-configured fallback when import questions stall, keeping
  // the same actions and placeholders.
  if (manualSetup) execFileSync('plutil', ['-remove', 'WFWorkflowImportQuestions', input], { stdio: 'inherit' });
  if (firstRunSetup) {
    const template = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', input], { encoding: 'utf8' }));
    const workflow = readingShortcutWithFirstRunSetup(template);
    await writeFile(input, JSON.stringify(workflow));
    // Retain the exact readable source alongside the signed test artifact.
    execFileSync('plutil', ['-convert', 'xml1', '-o', resolve(`dist/${name}.plist`), input], { stdio: 'inherit' });
  }
  execFileSync('plutil', ['-convert', 'binary1', input], { stdio: 'inherit' });
  // Only the public template, containing placeholders, is sent to Apple's signing service.
  execFileSync('shortcuts', ['sign', '--mode', 'anyone', '--input', input, '--output', resolve(`dist/${name}.shortcut`)], { stdio: 'inherit' });
} finally { await rm(temporary, { recursive: true, force: true }); }
