# Reading library and search on the server

Target: a 50,000-note Reading library in the web app, encrypted or not, where a visit and a
search cost about the same at 1,000 and 50,000 notes. Obsidian is unchanged: it reads its own
vault and searches with Obsidian.

Replaces the card index described in [Reading at large library sizes](reading-scale.md). The
plugin work on that page (frontmatter-cache library, background work) and **Save for offline**
stay.

## Model

- Reading notes stay ordinary synced notes and the only source of truth.
- `reading_items` holds one row per note: what the web app lists. Rows are derived and can be
  rebuilt.
- `note_terms` holds each listed note's search terms under scope `reading`: `w:` for a title
  word, `p:` for its first three letters, `t:` for a tag and `u:` for the link identity
  (`src/reading/core/search-terms.ts`). The scope lets other note indexes, such as a future
  vault-wide one, share the table.
- The web app never holds the library. It asks the server for one page at a time:
  `GET /reading/items?section=&q=&tag=&cursor=`, newest first.

## Unencrypted vaults

The Worker writes the row and its terms in the same D1 batch as the file commit, as it already
did for `reading_items`. Words are lowercased with diacritics removed. A search matches each query
word as the start of a title word, with a range over the `w:` terms; a tag or link filter matches
its term exactly.

## Encrypted vaults

The server cannot read notes, so the device that writes a note also writes its card. Only a
device holding the vault key can, which is why this is not done on the server:

- **A commit marks the row stale.** In the same batch as any file write in the Reading folder, the
  Worker records the path and its new revision, keeps the last card listed and marks it
  `stale = 1`. Deleting the note removes the row and its terms.
- **The web app sends the card with its commit.** An encrypted Reading commit
  (`POST /reading/encrypted-commit`) carries `cards`, one per note it writes, and the server stores
  each for the revision that commit writes, in the same transaction. The note is current the moment
  the commit succeeds.
- **Obsidian posts cards after each sync** (`src/reading/data/card-publisher.ts`). Sync uploads
  are unchanged; a few seconds after a sync completes, Obsidian lists stale rows
  (`GET /reading/cards/stale`), and for each note it holds with no change waiting to upload, reads
  it and posts its card (`POST /reading/cards`). A first encrypted upload of a large library is
  carded this way, without the web app downloading any note.
- **The web app fills what is left** when it opens Reading: stale rows no device posted, such as
  Shortcut saves the server sealed while Obsidian was closed. It downloads, checks and opens each.
- The server accepts a card only while its row still names that path and revision, so a card can
  never describe another version of the note.
- **The card** is the note's listed item (`ReadingItem`), sealed with the vault key and bound to
  the server path and revision.
- **List fields in plaintext**: saved date, status, favorite, whether the note has highlights and
  its Reading ID. The server sorts and filters by them; the device checks them against the card it
  decrypts and drops rows that disagree.
- **Terms** are HMAC-SHA256 under a search key derived from the vault key
  (`crate-e2ee-v1/reading-search`), truncated to 60 bits, of the same terms. A query sends, for
  each word, the hash of its first three letters (or of the whole word when it is shorter), so the
  server matches tokens it cannot read; the device rechecks the titles it decrypts.

### What the server learns

Beyond what it already sees (sizes, write times, folder structure):

- each note's saved date, status, favorite and whether it has highlights;
- which notes share a title word or prefix, a tag or a link, and the number of terms per note;
- when a search repeats, and which notes it matches.

It never sees words, titles, tags, links, highlights or article text. This belongs in the
independent security review listed in [Reading and encryption](reading-e2ee-assessment.md).

## Web app

- **Online**: the library, every section, search and the tag filter are server pages. The tag
  picker lists tags on the pages it loaded.
- **Offline**: the library shows articles saved with **Save for offline**, and search matches
  their titles on the device.
- Edits keep the pending-change queue, operation IDs and receipts. A pending edit is shown over
  the page that lists its note.
- Saving a link checks for a duplicate with a link-term query in encrypted vaults, and with the
  server's link index in unencrypted ones.

## Cost

- A page or a search reads about one page of rows plus the matched search entries; nothing grows
  with the library.
- A new or retitled note writes about two terms per title word; status and favorite edits keep
  the same terms and leave them untouched, but move the note between section indexes (two rows).
- An encrypted library is indexed once: each note is opened by one device and its card posted.
