# Plugin UI

Obsidian-only presentation: dialogs and the settings tab. Shared tokens, components and visual rules are in [UI styling](ui-styling.md).

## Sync status on mobile

Obsidian mobile hides plugin status bar items, so `ui/header-status.ts` adds the
shared sync indicator to each main-area view header instead; selecting it opens
sync activity. On mobile a failed sync also shows one notice until a sync
succeeds again, except offline and revoked access, which have their own notices.
On every platform, a sync that rewrites files in the configuration folder asks
once per session for a restart, because Obsidian reads most settings at launch.

## Plugin dialogs

Native dialogs use `SharedModal`; React content in an Obsidian shell uses
`ModalLayout`. Both use `ModalHeader`, 16px body insets, and a 12px/16px footer.
`ui/plugin/shared-modal.ts` owns `SharedModal`, its shell classes and the native
footer/action builders with the same layout as React's `crate-modal-actions`.
Buttons use the shared action mixins and semantic
variants, with 44px touch targets. Footers stay outside scrolling content.
Encryption setup retains a stable height through loading, progress and completion;
file history, conflict review and editor/picker sheets retain their workspace sizing.
Reminder deletion also uses `ModalLayout`, including its disabled close control
while deletion is pending. Diagnostics uses `SharedModal` and the shared text field.

`ui/shared/SettingsDisclosure.tsx` and `ui/plugin/settings-disclosure.ts` provide React and native
disclosure adapters, including an
inline variant for dialog sections. `_native-settings.scss` owns native `Setting`
row spacing, labels, descriptions and buttons inside shared native dialogs.
The main settings page retains its existing styles in `plugin/_settings.scss`
and `plugin-ui/_settings-alignment.scss`. Use these components and the dialog/settings tokens in `_tokens.scss`
instead of adding feature-specific row or footer geometry. Narrow dialogs stack
fields and multiple row actions; async callbacks, focus ownership and persistence
remain in the feature adapters.

## Plugin settings disclosure

Plugin settings use three top-level groups: **Sync** for connection status,
sync options, and web app access; **Features** for the matching **Reminders**,
**Reading**, and **Notifications** disclosures, where Reminders and Reading also
show without a server; and **Management** for
**Account and devices**, **Usage**, **Server**, and **Troubleshooting**. **Usage**
shows Cloudflare account metrics and allowances when an account is configured. Feature switches
live inside their disclosures. Collapsed rows summarize folder choices or status.
The web-app row has two visible actions: **Open app** and **Connect another device**.
Connecting another device opens a QR dialog with **Copy link**; if clipboard
access fails, the same dialog reveals a read-only setup link.
Collapsed folder and timing summaries show current choices. Reminder display
preferences disappear when local reminders are off; folder selection stays
available. Notifications remain independent of the local reminders switch.
Reading folder selection stays available while disabled because server folder
changes require Reading to be off.

**Account and devices**, **Usage**, and **Server** mount their contents on first expansion;
the notification toggle, schedule, and device controls mount when **Notifications**
opens. The collapsed status and notification toggle check the shared server policy.
Device lists are not fetched for collapsed sections. Management sections avoid
redundant nested accordions. Saved recovery operations surface a review action
at the top; update notices remain visible outside **Server**.

Native details/summary controls support keyboard expansion. Stable section keys
preserve expansion, control focus, and scroll across settings rerenders, even
when summary values change or expanded sections mount lazily.

Plugin disclosure rows use the same 16px content inset as settings cards, a subtle
border, a trailing CSS chevron, and smaller secondary summaries. Section headings
use a 20px/8px spacing rhythm. Expanded controls sit inside the disclosure without
nested card backgrounds. Narrow panes stack fields and multi-button actions below
their labels; buttons retain 44px targets. All colors come from Obsidian theme
variables and native summary keyboard behavior is preserved.

Encrypted app unlock defaults to **Connect with Obsidian**, with manual recovery
behind **Use recovery key instead**. Both app sections share this view. Pairing
uses one selectable, tabular comparison code, short instructions and existing
buttons; it does not expose key text fields. The Obsidian approval uses
`SharedModal` and native `Setting` buttons. Keep the code hidden until both peers
have completed the handshake and make approval an explicit action.

## Testing notes

Choosing and running suites is covered in [testing](testing.md).

### Plugin navigation parity

After building the plugin, run
`node scripts/visual-test-run.mjs tests/visual/plugin-navigation.spec.ts tests/visual/plugin-navigation-webkit.spec.ts --workers=2`.
The Shadow DOM fixture covers the production plugin navigation shell at narrow and
wide widths, Today/Upcoming selection, project Back and retained scroll/focus,
Reading search and article return, keyboard/held dock expansion, disabled features,
rapid switching, reduced motion, and compact project sheets. Run `node tests/browser/pwa/pwa-dock-test.mjs` and
`node tests/browser/pwa/pwa-schedule-test.mjs` after rebuilding the Worker for the shared
components’ PWA adapters. Actual Obsidian panes, popout windows and mobile navbar
insets still require host/device acceptance.

### Plugin dialog consistency

After building the plugin, run `npm run test:plugin-dialogs`. It compares computed
header, body, footer, row and button geometry across native dialogs,
and exercises reminder deletion in Shadow DOM. Coverage includes Chromium/WebKit,
light/dark themes, desktop/phone/short screens, narrow dialog containers,
clipboard actions, expanded disclosures and pending-delete dismissal. The encryption
suite also checks stable loading/progress/completion geometry and recovery-key
acknowledgment. Screenshots are saved under `.generated/plugin-dialog-review/` and
`.generated/encryption-ui-review/`. CI runs it in the third editor shard.

Set `CRATE_PLUGIN_CSS_PATH` to an isolated plugin build's stylesheet when another
build is using `dist/`. `CRATE_OBSIDIAN_CSS_PATH` optionally overlays a locally
extracted Obsidian `app.css` in both dialog harnesses. These fixtures do not replace
manual acceptance in Obsidian, community themes, or physical iOS/Android devices.
