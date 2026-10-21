import { dirname, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// Worker code may import only portable modules shared with the plugin and PWA,
// release metadata, and the PWA shell it serves. Directories end with a slash.
const allowed = [
  'src/cloudflare/worker/',
  'src/cloudflare/server-release.json', 'src/cloudflare/schema.sql', 'src/cloudflare/migrations/',
  'src/protocol/', 'src/encryption/', 'src/platform/',
  'src/reminders/core/', 'src/reminders/types/',
  'src/reading/core/', 'src/reading/extraction/', 'src/reading/shortcut', 'src/reading/settings', 'src/reading/ui/reading.scss',
  'src/pwa/shell/', 'src/pwa/update/update-screen', 'src/pwa/update/update-transition',
  'src/pwa/service-worker/config', 'src/pwa/styles/', 'src/pwa/reading/web.scss',
  'site/assets/',
];
const blockedPackages = new Set(['obsidian']);

const isAllowed = target => {
  const path = relative(root, target).split(sep).join('/').split('?')[0].replace(/\.(?:ts|tsx|js|mjs)$/, '');
  return allowed.some(entry => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
};

/**
 * Resolve paths so Worker-local modules named sync remain valid at any depth.
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem', schema: [],
    messages: { hostImport: 'Worker code uses portable protocol/domain modules and the PWA shell; keep plugin, sync and UI implementation in the Obsidian host.' },
  },
  create(context) {
    const check = source => {
      if (source?.type !== 'Literal' || typeof source.value !== 'string') return;
      const specifier = source.value;
      const target = specifier.startsWith('@/') ? resolve(root, 'src', specifier.slice(2))
        : specifier.startsWith('src/') ? resolve(root, specifier)
        : specifier.startsWith('.') ? resolve(dirname(context.filename), specifier) : null;
      if (target ? !isAllowed(target) : blockedPackages.has(specifier)) {
        context.report({ node: source, messageId: 'hostImport' });
      }
    };
    return {
      ImportDeclaration: node => check(node.source),
      ExportNamedDeclaration: node => check(node.source),
      ExportAllDeclaration: node => check(node.source),
      ImportExpression: node => check(node.source),
    };
  },
};
