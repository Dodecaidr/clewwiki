# Moving from Confluence

clewwiki imports a space from Confluence Cloud and from a Confluence Server or
Data Center of your own. Either way the import is staged: you see every page it
would create, with its path, its Markdown and a note about anything that did not
convert, and nothing exists until you press the button.

Atlassian ends Data Center on 28 March 2029, when environments become read-only,
and stopped selling it to new customers on 30 March 2026
([Atlassian](https://www.atlassian.com/licensing/data-center-end-of-life)). The
official Atlassian MCP server connects to Cloud sites only, so a team that stays
on its own server has no first-party way to put agents on its wiki.

## From Confluence Cloud

The importer reads a space over the Cloud REST API v2.

1. In Atlassian, create an API token for an account that can read the space and
   nothing more: <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. In clewwiki, open the target space, then **Import**, then **Confluence**.
   Enter the site address, the space key, the account e-mail and the token.
3. Review the staged tree. Untick what you do not want, change a path where a
   page belongs elsewhere, read the warnings.
4. Import. Revoke the token afterwards if it was made for the migration.

The e-mail and token are held in memory for that one run and written nowhere:
not to the database, not to the audit log, not to a log line.

What converts: the page hierarchy; headings, lists, tables, task lists,
blockquotes; the `code` macro with its language; `info`, `note`, `tip`,
`warning` and `panel` as callouts; `expand`; links between imported pages,
rewritten to the new pages; PNG, JPEG, GIF and WebP images attached to a page
and shown on it; and, when the instance takes files, every other attachment of
a page, which becomes one of that page's [files](guide.md#files) with its
earlier versions, each with the date and comment Confluence recorded — and on
a Server or Data Center the author's name.

What does not: comments, labels, restrictions and page history are not read.
An earlier version is carried only when the site serves it as recorded: some sites answer
a request for any old version with the latest bytes, and a download whose size
differs from Confluence's record of that version is left out with a warning
rather than stored as history it is not. Cloud records no size per version, so
there an earlier version is held to not being the current file's bytes. An attachment larger than the
instance takes (`FILES_MAX_UPLOAD_MB`), or one that would not fit the
workspace's store, is left out with a warning too. With files switched off,
attachments other than images stay as links to your Confluence site, with a
warning, and work only while that site does. A macro with no Markdown
equivalent — Jira lists, page trees, includes, charts — becomes a visible note
that names it, never a silent omission. [The guide](guide.md#import) has the
full table and the limits.

## From Confluence Server or Data Center

Read over the REST API v1. A page body is stored the same way as on Cloud, so
everything about the conversion above holds here too.

**First, the operator opens the site up.** A Confluence you host is usually on a
private network, and an import connects to an address somebody typed into a
form — so by default it connects only to public addresses. Whoever runs this
wiki lists the host names that may be reached:

```sh
IMPORT_CONFLUENCE_PRIVATE_HOSTS=wiki.corp.example
```

Only private ranges open up that way (10.x, 172.16–31.x, 192.168.x, IPv6 unique
local). The loopback, link-local — 169.254.169.254, where cloud metadata lives —
multicast and reserved space stay refused whatever is listed, and a name is
checked again as the socket connects, so a name server that answers differently
the second time changes nothing. A site already on a public address needs none
of this.

**Then the import itself.**

1. In clewwiki, open the target space, then **Import**, then **Confluence**, and
   choose **Confluence Server or Data Center**.
2. Give the address up to its context path — `https://wiki.example.com/confluence`,
   or just `https://wiki.example.com` when the site is at the root. It must be
   `https`.
3. Give the space key, and a credential:
   - a **personal access token** from your Confluence profile, with the username
     left empty (sent as `Bearer`); or
   - a **username and password** (sent as `Basic`); or
   - **neither**, for a space that is readable without signing in.
4. Review the staged tree, then import.

**What to expect.** The hierarchy comes from each page's ancestors and the order
from the position a person set in the page tree. Images attached to a page and
shown on it are downloaded, as on Cloud; the credential goes to your site and to
nowhere it redirects to. The listing is paged by counting rather than by
following the link the server offers, so an import reads a large space in runs of
fifty pages.

**If it does not work.** A site behind single sign-on where the REST API is not
reachable with a token, or a version older than the v1 API's `expand` of
`body.storage`, will not import. The route below is the way round it, and an
issue saying which version refused you is the most useful thing you can send.

## The way round: an HTML export

Any Confluence, however old or however locked down, can export a space as HTML,
and clewwiki imports a ZIP of Markdown.

1. In Confluence: **Space tools**, **Content tools**, **Export**, **HTML**. You
   get a ZIP with one HTML file per page and an `attachments` directory.
2. Convert the HTML files to Markdown. [pandoc](https://pandoc.org) does it:

   ```sh
   unzip Confluence-space-export.zip -d space && cd space
   for f in *.html; do
     pandoc -f html -t gfm --wrap=none -o "${f%.html}.md" "$f"
   done
   zip -r ../space-markdown.zip . -i '*.md' 'attachments/*'
   ```

3. In clewwiki: **Import**, then **Markdown folder**, and upload the ZIP.

What this route loses: an HTML export is flat, so the hierarchy has to be rebuilt
by changing paths in the staged tree, and every page carries Confluence's
breadcrumb and footer. Prefer the API route when it is open to you.

## Getting out again

A page exports as Markdown or HTML and a space as a ZIP of Markdown with its
images. Pages are stored as Markdown in the first place, so what you get back is
what you wrote.
