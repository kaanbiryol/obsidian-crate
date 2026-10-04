import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { unified } from '@astrojs/markdown-remark';
import { referencePages, remarkReferenceLinks } from './scripts/reference.mjs';

export default defineConfig({
  site: 'https://crate.kaanbiryol.com',
  base: '/docs',
  trailingSlash: 'always',
  output: 'static',
  outDir: '../site/docs',
  markdown: { processor: unified({ remarkPlugins: [remarkReferenceLinks] }) },
  integrations: [
    starlight({
      title: 'Crate Docs',
      description: 'Set up Crate, sync your Obsidian vault, and take your reminders and reading with you.',
      favicon: '/logo.png',
      social: [{ icon: 'github', label: 'Crate on GitHub', href: 'https://github.com/kaanbiryol/obsidian-crate' }],
      editLink: { baseUrl: 'https://github.com/kaanbiryol/obsidian-crate/edit/master/docs-site/' },
      customCss: ['./src/styles/custom.css'],
      components: {
        Head: './src/components/Head.astro',
        SiteTitle: './src/components/SiteTitle.astro',
      },
      credits: false,
      sidebar: [
        { label: 'Welcome', slug: 'index' },
        {
          label: 'Getting started',
          items: [
            'getting-started/installation',
            'getting-started/hosting',
            'getting-started/cloudflare',
            'getting-started/self-hosting',
            'getting-started/devices',
          ],
        },
        {
          label: 'Features',
          items: [
            'features/sync',
            'features/reminders',
            'features/embedded-reminders',
            'features/reading',
            'features/encryption',
          ],
        },
        {
          label: 'Troubleshooting',
          items: [
            'troubleshooting/connection',
            'troubleshooting/conflicts',
            'troubleshooting/recovery',
            'troubleshooting/notifications',
            'troubleshooting/updates',
          ],
        },
        {
          label: 'Developer reference',
          collapsed: true,
          items: referencePages.map(({ slug, title }) => ({ label: title, slug: `reference/${slug}` })),
        },
      ],
    }),
  ],
});
