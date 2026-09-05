/** Display note links without changing the stored reminder or external link targets. */
export function readableWikiLinks(content: string): string {
  return content.replace(/\[\[([^\]\n[]+)\]\]/g, (_match, target: string) => {
    const [path = '', alias] = target.split('|');
    if (alias?.trim()) return alias.trim();
    const [note = '', heading] = path.split('#');
    const title = (note.split('/').pop() || '').replace(/\.md$/i, '');
    return heading ? [title, heading].filter(Boolean).join(' › ') : title;
  });
}
