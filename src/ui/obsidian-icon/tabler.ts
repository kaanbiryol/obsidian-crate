import { addIcon } from "obsidian";
import { TABLER_ICONS } from "../shared/icons/tabler-icons.generated";

const PREFIX = "crate-tabler-";
let registered = false;

/**
 * Obsidian icon id for a Crate icon. Bundled Tabler icons are registered under a
 * prefix on first use so other plugins' and Obsidian's own icons stay untouched;
 * ids without a Tabler drawing fall back to Obsidian's built-in icons.
 */
export function obsidianIconId(id: string): string {
  const body = TABLER_ICONS[id];
  if (!body) return id;
  if (!registered) {
    registered = true;
    // Obsidian draws custom icons in a 100-unit box; scale the 24-unit Tabler
    // drawing and keep Obsidian's stroke width so they match native icons.
    for (const [name, markup] of Object.entries(TABLER_ICONS)) {
      addIcon(PREFIX + name, `<g transform="scale(4.1666667)" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" style="stroke-width: var(--icon-stroke, 2px)">${markup}</g>`);
    }
  }
  return PREFIX + id;
}
