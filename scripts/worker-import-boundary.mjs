import { dirname, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const hostDirectories = ['sync', 'plugin'].map(name => resolve(root, 'src', name));

/**
 * Resolve paths so Worker-local modules named sync remain valid at any depth.
 * @type {import('eslint').Rule.RuleModule}
 */
export default {
  meta: {
    type: 'problem', schema: [],
    messages: { hostImport: 'Worker code uses portable protocol/domain modules; keep plugin and sync implementation in the Obsidian host.' },
  },
  create(context) {
    const check = source => {
      if (source?.type !== 'Literal' || typeof source.value !== 'string') return;
      const specifier = source.value;
      const target = specifier.startsWith('@/') ? resolve(root, 'src', specifier.slice(2))
        : specifier.startsWith('src/') ? resolve(root, specifier)
        : specifier.startsWith('.') ? resolve(dirname(context.filename), specifier) : null;
      if (target && hostDirectories.some(directory => target === directory || target.startsWith(directory + sep))) {
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
