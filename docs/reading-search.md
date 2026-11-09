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
- `reading_search`, an SQLite FTS5 table, holds one document per row: the title terms, tag
  terms and, in an encrypted vault, the link term. Its `rowid` is the row's `doc`.
- The web app never holds the library. It asks the server for one page at a time:
  `GET /reading/items?section=&q=&tag=&cursor=`, newest first.

## Unencrypted vaults

The Worker writes the row and its search document in the same D1 batch as the file commit, as it
already did for `reading_items`. A search matches each word of the query as a prefix of a title
word (`"word"*`), using FTS5's `unicode61` tokenizer with diacritics removed. A tag filter matches
the tag column and is rechecked against the row's tags.

## Encrypted vaults

The server cannot read notes, so devices write the rows:

- **A commit marks the row stale.** In the same batch as any file write in the Reading folder, the
  Worker records the path and its new revision with no card (`stale = 1`) and drops its search
  document. Deleting the note removes the row. Sync and commit routes are unchanged.
- **Any unlocked device fills stale rows.** It lists them (`GET /reading/cards/stale`), opens each
  note, and posts the encrypted card, the plaintext list fields and the hashed terms
  (`POST /reading/cards`). The server accepts a card only while its row still names that revision,
  so a card can never describe another version of the note.
- **The card** is the note's listed item (`ReadingItem`), sealed with the vault key and bound to
  the server path and revision.
- **List fields in plaintext**: saved date, status, favorite, whether the note has highlights and
  its Reading ID. The server sorts and filters by them; the device checks them against the card it
  decrypts and drops rows that disagree.
- **Terms** are HMAC-SHA256 under a search key derived from the vault key
  (`crate-e2ee-v1/reading-search`), truncated to 60 bits: every prefix of 2 to 16 characters of
  each normalized title word, each tag, and the link identity. A query sends the same hashes for
  its words (the last as a prefix), so the server matches tokens it cannot read. Words longer
  than 16 characters match on their first 16; the device rechecks titles it decrypts.
- The web app fills stale rows when it opens Reading, a few at a time, before it lists. Shortcut
  captures arrive this way, as do notes Obsidian synced.

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
- A note write adds the FTS5 document change, about 3 to 6 rows; status and favorite edits keep
  the same terms and leave it untouched.
- An encrypted library is indexed once: each note is opened by one device and its card posted.
