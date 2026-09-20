# Moving from Confluence

Two routes, depending on where your Confluence runs. Both end the same way: an
import in clewwiki is staged, so you see every page it would create, with its
path, its Markdown and a note about anything that did not convert, and nothing
exists until you press the button.

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
and shown on it.

What does not: comments, labels, restrictions and page history are not read.
Attachments other than those images stay as links to your Confluence site, with
a warning, and work only while that site does. A macro with no Markdown
equivalent — Jira lists, page trees, includes, charts — becomes a visible note
that names it, never a silent omission. [The guide](guide.md#import) has the
full table and the limits.

## From Confluence Server or Data Center

The importer has not been tested against Server or Data Center: their REST API
is an older version with a different shape. Until that changes, the route is
through Markdown, which clewwiki imports as a ZIP of files.

1. In Confluence, export the space as HTML: **Space tools**, **Content tools**,
   **Export**, **HTML**. You get a ZIP with one HTML file per page and an
   `attachments` directory.
2. Convert the HTML files to Markdown. [pandoc](https://pandoc.org) does it:

   ```sh
   unzip Confluence-space-export.zip -d space && cd space
   for f in *.html; do
     pandoc -f html -t gfm --wrap=none -o "${f%.html}.md" "$f"
   done
   zip -r ../space-markdown.zip . -i '*.md' 'attachments/*'
   ```

3. In clewwiki, open the target space, then **Import**, then **Markdown
   folder**, and upload `space-markdown.zip`.
4. Review the staged tree as above.

Be ready for what this route loses. An HTML export is flat, so the page
hierarchy has to be rebuilt by changing paths in the staged tree. Every page
carries Confluence's breadcrumb and footer, which you will want to strip before
or after. Macros arrive as whatever HTML they rendered to. We have run the
Markdown importer at length; we have not run this whole route against a live
Data Center site, so try it on one small space first. If you do, an issue saying
what broke is the most useful thing you can send.

## Getting out again

A page exports as Markdown or HTML and a space as a ZIP of Markdown with its
images. Pages are stored as Markdown in the first place, so what you get back is
what you wrote.
