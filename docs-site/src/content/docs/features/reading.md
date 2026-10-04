---
title: Reading
description: Save articles, organize your library, highlight passages, and read across your devices.
---

Save articles for later and keep their text in your Obsidian vault. Reading is included with Crate, alongside sync and reminders.

## Save your first article

1. Choose a folder under **Settings → Crate → Reading**.
2. Run **Crate: Reading - add link** and paste an article URL.
3. Run **Crate: Reading - open library** to find it in your inbox.

In Obsidian, Crate saves a bookmark first, then downloads the article on that device. This works without a Crate server connection. If downloading fails, the bookmark remains and the reader offers **Try again**.

Without encryption, the web app uses your server to download articles. It contacts the source website without your browser cookies or Crate credentials, so pages requiring a login may remain saved links.

With [end-to-end encryption](/docs/features/encryption/), the web app downloads directly where the source website allows it. Other links wait for an unlocked Obsidian device to extract the article. Articles, URLs, tags, and highlights stay encrypted on the server.

## Organize your library

Use your inbox for unread articles, favorites for pieces to return to, and the archive for finished reading. Search your library or filter by tag. Select **Tags** in an article to add or remove tags.

Article text and reading metadata live in Markdown notes and use normal vault sync. Changing the configured Reading folder does not move existing files.

## Use Obsidian Web Clipper

Configure Web Clipper to save into your Reading folder in the intended vault. No Crate template is required.

Markdown notes in that folder and its subfolders appear in Reading. Crate preserves their body and filename, adopts existing tags, and does not download the article again. Notes without a source URL appear as vault notes.

## Highlight and revisit passages

Select text in the reader to save a highlight. Tap or select a saved highlight to copy, share, delete, or resize it. The article's **Highlights** view includes personal notes and a **View in article** action.

The library's **Highlights** view collects excerpts across your inbox, favorites, and archived articles. You can search and filter them by article or tag.

Highlights sync with the note. Ordinary passages use Obsidian's `==highlight==` syntax; selections that cannot safely use those markers are stored as annotations and displayed in Crate's reader. See the [highlight format reference](https://github.com/kaanbiryol/obsidian-crate/blob/master/docs/reading-highlights.md) for details.

## Read on your phone

[Connect the web app](/docs/getting-started/devices/#open-the-web-app) to use the same library outside Obsidian. You can paste a link directly into the library.

On iPhone with iOS 27 or later, **Reading settings → Set up iPhone shortcut** walks you through installing and pairing **Save to Crate**. Pairing codes are single-use and expire after ten minutes. Once paired, use **Share → Save to Crate**; the shortcut needs a connection.

After enabling encryption, reinstall the current shortcut. Sharing opens the link in Crate; unlock Reading if asked, then select **Save**.

On Android browsers that support Web Share Target, unencrypted vaults can use **Share → Crate** after installing the web app. For encrypted vaults, paste the link into Crate’s Reading library.

## Read offline

The web app caches opened article text, up to 50 articles or 20 MB. Open the articles you want before going offline; the entire library is not downloaded automatically.

Offline reading saves and edits remain pending until the server confirms them. Export pending work before clearing browser data or signing out. If something is stuck, see [Recovery](/docs/troubleshooting/recovery/#pending-work-in-the-web-app).

## Privacy and availability

Article bodies suppress remote images and active HTML. Library favicons may be requested from the saved site or its icon host. Your hosting resources handle server-side article downloads; Crate does not use a separate extraction service.

The **Enable reading** switch pauses scanning and downloads across connected devices while keeping notes, connections, and vault sync. It does not delete your library.
