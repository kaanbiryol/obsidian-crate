import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// Worker code may import only portable modules shared with the plugin and PWA,
// release metadata, and the PWA shell it serves. Directories end with a slash.
const allowed = [
  'src/cloudflare/worker/',
  'src/cloudflare/server-release.json', 'src/cloudflare/schema.sql', 'src/cloudflare/migrations/',
  'src/protocol/', 'src/encryption/', 'src/platform/',
  'src/reminders/core/',
  'src/reading/core/', 'src/reading/extraction/', 'src/reading/shortcut', 'src/reading/settings', 'src/reading/ui/reading.scss',
  // The PWA shell the Worker renders. Browser-only shell modules stay off this list.
  'src/pwa/shell/version', 'src/pwa/shell/pwa-params', 'src/pwa/shell/theme', 'src/pwa/shell/opening-dock',
  'src/pwa/shell/opening-screen', 'src/pwa/shell/browser-setup-gate', 'src/pwa/shell/share-target', 'src/pwa/shell/update-screen', 'src/pwa/shell/update-markers',
  'src/pwa/service-worker/config', 'src/pwa/styles/', 'src/pwa/reading/web.scss',
  // Pure modules the shell reaches at runtime.
  'src/pwa/settings/dock-preferences', 'src/pwa/settings/preferences', 'src/pwa/navigation/opening-destination',
  'src/ui/shared/spinner-spokes', 'src/ui/shared/navigation/dock-destinations', 'src/ui/shared/list-style',
  'src/reading/shortcut-contract.json',
  'site/assets/',
];
const blockedPackages = new Set(['obsidian']);

const repoPath = target => relative(root, target).split(sep).join('/').split('?')[0];
const isAllowed = target => {
  const path = repoPath(target).replace(/\.(?:ts|tsx|js|mjs)$/, '');
  return allowed.some(entry => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
};

const resolveSpecifier = (specifier, importer) => specifier.startsWith('@/') ? resolve(root, 'src', specifier.slice(2))
  : specifier.startsWith('src/') ? resolve(root, specifier)
  : specifier.startsWith('.') ? resolve(dirname(importer), specifier) : null;

const sourceFile = target => {
  const base = target.split('?')[0];
  return ['.ts', '.tsx', '.js', '.mjs', '/index.ts'].map(extension => base + extension)
    .find(candidate => existsSync(candidate) && statSync(candidate).isFile());
};

// Type-only imports are erased, so only runtime imports reach the Worker bundle.
const runtimeSpecifiers = text => [
  ...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm),
  ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
].map(match => match[1]);

const workerDirectory = resolve(root, 'src/cloudflare/worker') + sep;
const reached = new Map();
/** The first module outside the allowlist that an allowed shared module imports at runtime,
 * directly or through other shared modules. Worker files are linted on their own. */
const disallowedDependency = target => {
  const file = sourceFile(target);
  if (!file || file.startsWith(workerDirectory)) return null;
  if (reached.has(file)) return reached.get(file);
  reached.set(file, null);
  let found = null;
  for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
    const next = resolveSpecifier(specifier, file);
    if (next ? !isAllowed(next) : blockedPackages.has(specifier)) found = next ? repoPath(next) : specifier;
    else if (next) found = disallowedDependency(next);
    if (found) break;
  }
  reached.set(file, found);
  return found;
};

/**
 * Resolve paths so Worker-local modules named sync remain valid at any depth.
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem', schema: [],
    messages: {
      hostImport: 'Worker code uses portable protocol/domain modules and the PWA shell; keep plugin, sync and UI implementation in the Obsidian host.',
      transitiveHostImport: 'This shared module reaches {{path}} at runtime, which Worker code may not use. Allowlist it in scripts/worker-import-boundary.mjs only if it is portable.',
    },
  },
  create(context) {
    const check = source => {
      if (source?.type !== 'Literal' || typeof source.value !== 'string') return;
      const specifier = source.value;
      const target = resolveSpecifier(specifier, context.filename);
      if (target ? !isAllowed(target) : blockedPackages.has(specifier)) {
        context.report({ node: source, messageId: 'hostImport' });
        return;
      }
      const path = target && disallowedDependency(target);
      if (path) context.report({ node: source, messageId: 'transitiveHostImport', data: { path } });
    };
    return {
      ImportDeclaration: node => check(node.source),
      ExportNamedDeclaration: node => check(node.source),
      ExportAllDeclaration: node => check(node.source),
      ImportExpression: node => check(node.source),
    };
  },
};
