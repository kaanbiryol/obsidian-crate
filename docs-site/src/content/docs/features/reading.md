---
title: Reading
description: Save articles, organize your library, highlight passages, and read across your devices.
---

Save articles for later and keep their text in your Obsidian vault. Reading is included with Crate, alongside sync and reminders.

## Save your first article

1. Start with the default `Reading` folder. If you have connected a server, you can choose another under **Settings → Crate → Reading → Reading folder**.
2. Run **Crate: Reading - add link** and paste an article URL.
3. Run **Crate: Reading - open library** to find it in your inbox.

In Obsidian, Crate saves a bookmark first, then downloads the article on that device. This works without a Crate server connection. If downloading fails, the bookmark remains and the reader offers **Try again**.

## Where articles are downloaded

The save form tells you which device downloads the article:

| Where you save | What happens |
| --- | --- |
| Obsidian | This device downloads the article and writes a Markdown note. Normal vault sync carries it to your other devices. |
| Web app without encryption | Your Crate server downloads it. Obsidian can be closed. |
| Web app with encryption | The browser tries a direct download. If the website blocks it, the save waits for an unlocked Obsidian device to extract it. |

Pages requiring a login, blocking downloads, or relying on scripts may remain saved links. Server downloads do not use your browser cookies or Crate credentials. Use **Try again**, open the original page, or use [Web Clipper](#use-obsidian-web-clipper) for content you can access in your browser.

With [end-to-end encryption](/docs/features/encryption/), article text, URLs, tags, and highlights stay encrypted on the server.

## Organize your library

Use your inbox for unread articles, favorites for pieces to return to, and the archive for finished reading. Archiving keeps the article in your library. Search your library or filter by tag. Select **Tags** in an article to add or remove tags.

Article text and reading metadata live in Markdown notes and use normal vault sync. Changing the configured Reading folder does not move existing files.

## Use Obsidian Web Clipper

Configure Web Clipper to save into your Reading folder in the intended vault. No Crate template is required.

Markdown notes in that folder and its subfolders appear in Reading. Crate preserves their body and filename, adopts existing tags, and does not download the article again. Notes without a source URL appear as vault notes.

If several clipped notes have the same source, **Review duplicate sources** lets you compare them. In Obsidian, **Fill empty bookmark** can copy a clip into an empty saved-link note. It preserves the existing bookmark's identity and keeps the original clip for you to review.

## Save YouTube videos and transcripts

Save a YouTube link just like an article. Crate tries to save its public details and transcript. Captions are not always available; when they cannot be fetched, the video remains a usable bookmark.

Select the play icon, tap a transcript passage, or select transcript text to load the online player and play from that point. **Open in YouTube** appears if embedded playback fails. Crate does not download the video.

**Pin video** keeps the video above the transcript and smoothly follows playback, including when you seek in the video. Scrolling holds still while you select text or edit a highlight. **Unpin video** lets you scroll independently. Drag the handle below the video to resize it up to the full reader width. Pinning an oversized video shrinks it enough to leave room for the transcript.

You can highlight transcript passages and add notes. Cached transcript text remains available offline. A plain transcript without timestamps is still readable and highlightable.

Web Clipper can also save a transcript into your Reading folder. Check its preview: a note containing only a video embed does not contain the transcript. The repository includes an optional [Reading Clipper template](https://github.com/kaanbiryol/obsidian-crate/blob/master/templates/crate-reading-clipper.json) for saving full extracted content.

## Highlight and revisit passages

Select text in the reader to save a highlight. Tap or select a saved highlight to copy, share, delete, or resize it. The article's **Highlights** view includes personal notes and a **View in article** action.

The library's **Highlights** view collects excerpts across your inbox, favorites, and archived articles. You can search and filter them by article or tag.

Highlights sync with the note. Ordinary passages use Obsidian's `==highlight==` syntax; selections that cannot safely use those markers are stored as annotations and displayed in Crate's reader. See the [highlight format reference](https://github.com/kaanbiryol/obsidian-crate/blob/master/docs/reading-highlights.md) for details.

## Read on your phone

[Connect the web app](/docs/getting-started/devices/#open-the-web-app) to use the same library outside Obsidian. You can paste a link directly into the library.

On iPhone with iOS 27 or later, **Reading settings → Set up iPhone shortcut** walks you through installing and pairing **Save to Crate**. Pairing codes are single-use and expire after ten minutes. Once paired, use **Share → Save to Crate**; the shortcut needs a connection.

You can also get the shortcut from [Crate’s iPhone shortcut page](/shortcuts/v2/). Select **Download shortcut**, then **Add Shortcut**, and return to Reading settings to create a pairing code. If the page says the shortcut is not available yet, use **Reading → Save a link** until it is published.

After enabling encryption, reinstall the current shortcut. Sharing opens the link in Crate; unlock Reading if asked, then select **Save**.

On Android browsers that support Web Share Target, unencrypted vaults can use **Share → Crate** after installing the web app. For encrypted vaults, paste the link into Crate’s Reading library.

## Read offline

In Obsidian, downloaded article text lives in your vault and remains readable offline. The web app caches opened article text, up to 50 articles or 20 MiB. Open the articles you want before going offline; the entire library is not downloaded automatically.

Offline reading saves and edits remain pending until the server confirms them. Export pending work before clearing browser data or signing out. If something is stuck, see [Recovery](/docs/troubleshooting/recovery/#pending-work-in-the-web-app).

## Privacy and availability

Article bodies suppress remote images and active HTML. Library favicons can contact the saved site or its icon host, and YouTube thumbnails can contact YouTube's image host. Those hosts see the request and may receive their own cookies; Crate does not send your Crate credentials or a page referrer with these images.

The YouTube player loads when you select the play icon or interact with a timed transcript passage. It contacts YouTube and may use its cookies and receive your app's origin as a referrer. It does not receive your Crate credentials or note contents.

Your hosting resources handle server-side article downloads; Crate does not use a separate extraction service. Reading notes have a 1 MiB limit, even though larger files can still qualify for ordinary vault sync.

## Pause or resume Reading

Under **Settings → Crate → Reading**, turn off **Enable reading** to pause scanning and downloads across connected devices. Turn it on again to resume. Notes, connections, and vault sync are kept; your library is not deleted. Changing the shared switch requires a connection.

There is no separate article-download switch. See [Choose and manage features](/docs/features/settings/) for the other controls and their scope.
