import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shortcutName, sourceHash } from './shortcut-release.mjs';

// Development Workers serve the shortcut signed from the working tree so native
// changes can be installed from the dev PWA without publishing a release.
// Signing contacts Apple, so each source revision is signed once and cached.
export async function developmentShortcut(root, { sign = signShortcut, cache = resolve(root, '.generated/development-shortcut'), platform = process.platform } = {}) {
  if (platform !== 'darwin') {
    console.log('Skipping the development shortcut: signing requires macOS with Apple Shortcuts.');
    return null;
  }
  const directory = resolve(cache, await sourceHash(root));
  const file = resolve(directory, shortcutName);
  if (!existsSync(file)) {
    try {
      sign(root, directory);
    } catch (error) {
      console.warn(`Skipping the development shortcut: signing failed (${error instanceof Error ? error.message : String(error)}).`);
      return null;
    }
  }
  return readFileSync(file).toString('base64');
}

function signShortcut(root, directory) {
  execFileSync(process.execPath, ['scripts/sign-reading-shortcut.mjs', '--pairing', `--out-dir=${directory}`], { cwd: root, stdio: 'inherit' });
}
