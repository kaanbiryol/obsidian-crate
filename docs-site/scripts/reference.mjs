import path from 'node:path';

export const referencePages = [
  { slug: 'architecture', title: 'Architecture', description: 'Plugin, server, and web app responsibilities.' },
  { slug: 'sync-pipeline', title: 'Sync pipeline', description: 'How Crate discovers, plans, and transfers vault changes.' },
  { slug: 'protocol', title: 'Protocol', description: 'The vault sync and mutation protocol contract.' },
  { slug: 'worker-api', title: 'Worker API', description: 'Server endpoints, authentication, request formats, and responses.' },
  { slug: 'current-contract', title: 'Current contract', description: 'Source-checked server revisions, storage formats, and limits.' },
  { slug: 'compatibility', title: 'Compatibility', description: 'Supported formats, upgrades, and rollback policy.' },
  { slug: 'server-upgrades', title: 'Server upgrades', description: 'Versioning, migration, and server release contracts.' },
  { slug: 'self-hosting', title: 'Self-hosting commands', description: 'Docker and local server operations, tunnels, backups, and restore.' },
];

const publishedSources = new Map(referencePages.map(({ slug }) => [`docs/${slug}.md`, `/docs/reference/${slug}/`]));
const repository = 'https://github.com/kaanbiryol/obsidian-crate/blob/master/';

// Rewrite Markdown link nodes, leaving code examples and literal source paths intact.
// References are copied unchanged from docs/ before Astro reads the collection.
export function remarkReferenceLinks() {
  return (tree, file) => {
    const filename = file.path?.replaceAll('\\', '/');
    if (!filename?.includes('/content/docs/reference/')) return;
    const source = `docs/${path.posix.basename(filename)}`;
    function visit(node) {
      if (['link', 'image', 'definition'].includes(node.type) && node.url && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(node.url)) {
        const destination = new URL(node.url, `https://repository.invalid/${source}`);
        const relativePath = decodeURIComponent(destination.pathname.slice(1));
        const route = publishedSources.get(relativePath);
        node.url = (route ?? `${repository}${relativePath}`) + destination.search + destination.hash;
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}
