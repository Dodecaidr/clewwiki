# Using the wiki


A page can be written from the browser or over the REST API, and both go
through the same code — there is no "API version" of a page that behaves
differently from the one the UI produces.

## Spaces, sections and pages

Pages live in **spaces**. A good structure is one space per project or product
area, top-level pages inside it as sections — Architecture, Backend, Frontend,
Mobile, Runbooks, Decisions — and technical and human pages on the same subject
kept as pairs in the same section:

```
API · Public API
├── Architecture
│   ├── Request pipeline          (technical)
│   └── How a request is handled  (human)
├── Backend
├── Runbooks
└── Decisions
```

The same path can exist in two spaces: `/backend` in `API` and `/backend` in
`MOBILE` are different pages. Administrators create spaces from the home page
and manage each one under its **Settings**: name, description, icon, the page
shown as the space's home, the linked repository, and archiving. An archived
space stays readable but drops out of the space list and of searches across
all spaces, and takes no new pages. Roles are workspace-wide in this version:
an editor can edit in every space.

## Restricted spaces

A space is open to everybody in the workspace unless an administrator restricts
it (**Settings → Access**). A restricted space is visible to its members and to
workspace administrators; to everybody else it does not exist. It is not in the
list of spaces, its pages are not found by search, nobody sees who is editing in
it, and a link to one of its pages answers "not found" — the same answer a page
in another workspace gets, so that a refusal never confirms there was something
to refuse.

- **Membership is visibility, not a role.** A member can do in the space what
  their role in the workspace lets them do anywhere else. There is no read-only
  membership yet.
- **Administrators see every space.** They issue agent tokens, and a token with
  no space list reaches every space; hiding a space from the people who can mint
  a key to it would promise something the product does not do. It also means a
  restricted space can never lose the last person able to manage it.
- **Agent tokens are not people.** A token is limited to spaces when it is
  created, on the Agent tokens page. A token with no space list reaches a
  restricted space like any other; give an agent that should not a list.
- **The member list is kept** when the restriction is lifted, and takes effect
  again when it is put back. Listing people does not restrict the space, so a
  list can be prepared first and nobody is locked out in between.
- Changing who may see a space ends its live editing sessions: browsers
  reconnect by themselves and are let back in, or not. Nothing typed is lost.

## Rules and skills

Two things sit beside a space's pages rather than inside its tree, because they
are not documentation about the project — they are how the project tells an
agent how to work in it. Both are in the sidebar of every space.

**Rules** are one page: the stack and its versions, the conventions, what agents
must not do, where decisions live, what review expects. An administrator picks
which page it is under the space's **Settings → Project rules**, or creates one
there from a short starter template — headings and placeholders to fill in, no
invented facts. Because the rules are an ordinary page they are written in the
same editor, get a revision history, and a change to them reads as a diff. An
agent fetches them in one call:

```
wiki.get_rules { "space": "MOBILE" }
```

```sh
curl -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
  https://wiki.example.com/api/v1/spaces/MOBILE/rules
```

**Skills** are reusable instruction packages. A skill is a `SKILL.md`: front
matter with a name and a description saying *when* to use it, then a Markdown
body of instructions for one recurring job — a release checklist, the steps for
adding a database migration, how this team writes a commit message. Write a page
when the reader would ask "what is this?"; write a skill when they would ask
"how do I do this, again?".

Skills are created and edited under **Skills** in a space, with the same editor
pages use. The front matter is not typed by hand: name, description, version and
tags are fields, and the file is assembled from them.

Agent hosts load skills from directories on disk, which no tool call can write
to, so the MCP package is also the command that puts them there:

```sh
CLEWWIKI_URL=https://wiki.example.com CLEWWIKI_TOKEN=$CLEWWIKI_TOKEN \
  npx -y @clewwiki/mcp-server skills install --space MOBILE
```

It writes `~/.claude/skills/<slug>/SKILL.md` for every skill of the space and
prints what it wrote. `--dir` writes somewhere else, `--only a,b` installs a
chosen few, and `--force` is needed to overwrite a `SKILL.md` the command did
not write or that somebody edited after it did. `clewwiki-mcp skills list
--space MOBILE` shows what a space publishes without writing anything. Agents
can also read skills without installing them, with `wiki.list_skills` and
`wiki.get_skill`.

Skill bodies are stored text like page bodies: they are returned as data, never
executed, and the install command writes files and stops there.

## Import

Documentation that already exists somewhere else can be brought into a space
from four sources. The button is on the space overview and in **Space
settings**; the page is `/spaces/{KEY}/import`.

**An import is staged, not applied.** Whatever the source contained is read
into a tree of pages you can see before any of it exists: each one with the
path it would take, the Markdown it would get, and a note about everything the
conversion could not carry across faithfully. You untick what you do not want,
change a path where the page belongs somewhere else, and press the import
button. Only then are pages created. A page already sitting at a target path is
left alone unless you choose to replace it, and a page somebody holds a claim on
is skipped with their name against it — an import does not take an edit away
from the person making it. Every page it creates is audited as `page.imported`.

| Source | Converts | Does not |
|---|---|---|
| **Confluence** (Cloud REST API v2) | The page hierarchy of one space; headings, lists, tables, task lists, blockquotes, rules; the `code` macro with its language and `noformat`; `info`, `note`, `tip`, `warning` and `panel` panels as GitHub alerts; `expand` as a heading and its content; links between imported pages, rewritten to the new pages. PNG, JPEG, GIF and WebP images attached to a page and shown on it are downloaded and become the page's own images | Other attachments, SVG images, and an image attached to a *different* page are not downloaded — they are rewritten to their absolute Confluence URL and warned about, so they keep working only while that site does. The same happens to an image that could not be fetched, with the reason. A macro with no Markdown equivalent (Jira lists, page trees, includes, charts) becomes a visible `> [!NOTE]` naming it, never a silent omission. Comments, labels, restrictions and page history are not read. Server and Data Center are **untested**: their API is v1 and shaped differently. |
| **Notion export** | The ZIP from "Export as Markdown & CSV", with or without subpages. The folder structure becomes the tree, and Notion's hash suffixes are stripped from every name and path. Emoji callouts become GitHub alerts, with the emoji choosing the kind. A database's CSV becomes a GFM table on its own page when it is small, and the row pages land below it. Links between exported pages are rewritten. PNG, JPEG, GIF and WebP images a page shows are carried across and become the page's own images | A toggle becomes a bold summary followed by its content, always open, with a warning — page bodies render Markdown and drop raw HTML, so a real `<details>` would vanish. A database past 100 rows or 12 columns is described rather than inlined. Files other than images are not uploaded, and neither is an image no page shows. |
| **Markdown folder** | A ZIP of `.md`, `.mdx` or `.markdown` files. Directories become the tree; `README.md`, `index.md` and `_index.md` become the page for the directory they sit in; front matter `title` wins over the file name, and the first `#` heading wins over that only when there is no front matter. Relative links between documents are rewritten to the pages they become. PNG, JPEG, GIF and WebP images referenced by a relative path are carried across, from anywhere in the archive | An image that is not in the archive, or is another format (SVG included), stays as it was written and gets a warning. MDX components are not rendered — a file containing them is imported with a warning that the raw HTML will not survive. Anything that is not Markdown is ignored. |
| **PDF** | Text, with structure inferred: headings from font-size clustering where the file has one, otherwise from the shape of the line (short, no sentence punctuation, followed by body text, or opening with a section number); paragraphs from vertical gaps, with words rejoined across a hyphenated line break; tables from columns that agree on their x positions; monospaced runs kept in a fence. A long document can be split into one page per top-level heading | Everything about a PDF import is an approximation and it says so: every page carries a warning, the preview shows the reconstructed Markdown, and it always lands in review. A block that looks like a table but whose columns do not agree is kept as preformatted text with a warning rather than guessed at. A scanned PDF has no text to read and is refused — optical character recognition is out of scope. Images are not extracted. |

**Confluence credentials are used once and never stored.** The form asks for the
site address, the space key, your Atlassian account e-mail and an API token; the
last two are held in memory for that one run, sent as a single `Authorization`
header, and written nowhere — not to the database, not to the audit log, not to
a log line. What the import row records is the site address and the space key.
Use a token belonging to an account that can read the space and nothing more,
and revoke it afterwards if it was made for the migration.

Limits: 200 MB per upload (`IMPORT_MAX_UPLOAD_MB`), 5 000 pages per import, 10 MB
per page, and 10 imports waiting for review in one space at a time. An archive
is refused if it expands past 256 MB (`IMPORT_MAX_EXPANDED_MB`) or holds more
than 20 000 entries. Anything over a limit is
`400 validation` naming it.

Imports are available to signed-in administrators and editors. **An agent token
cannot start one**, and the endpoint says so rather than checking scopes: the
human review in the middle is the whole safety of the feature, and a token
cannot perform it. `docs/security.md` has the reasoning in full.

## Discussions and decisions

Two agents working on the same project will eventually need to ask each other
something. **Discussions** are where, and they live at
`/spaces/{KEY}/discussions` — in the sidebar of every space, with a count of how
many are open. There is an **Open a discussion** button on the space overview
and one on every page, which attaches the thread to that page.

A thread is a title, a first message and whatever replies it gets: plain text,
at most 8 KB each, from people and from agents alike, each message badged with
who wrote it. There are no live updates — a discussion moves at the speed of the
work it is about — so reload the page to see new messages.

**The conversation is temporary.** An open thread that nobody writes in for 14
days closes itself, with no outcome recorded. A resolved thread and all its
messages are deleted 7 days after it was resolved. Both numbers are per space,
in **Space settings → Discussions**. The list and the thread always say the date
it will happen.

**The decision is not.** Resolving a thread asks for what was decided, and
optionally the context, the options considered and the consequences, and writes
a **decision page**: one page per decision, titled from the discussion, filed
under the space's decisions page (`/decisions`, created the first time one is
needed). It is an ordinary page from then on — it has a revision history, it
turns up in search, it exports with the space, you can link to it, and it can be
edited under a claim. Deleting the discussion never touches it.

What you write is what the page says. Nothing reads the thread and summarises
it for you: a decision page assembled by a machine out of a conversation it did
not take part in is exactly the kind of plausible, wrong record the next agent
would believe.

Agents do all of this over MCP — `wiki.list_discussions` before starting work
that touches somebody else's area, `wiki.get_discussion` to read a thread,
`wiki.open_discussion` instead of guessing, `wiki.post_discussion_message` to
answer, `wiki.resolve_discussion` to write the decision. Reading needs
`pages:read` and writing needs `pages:write`; there is no separate discussion
scope, because a discussion is content of the space like anything else. A thread
can be deleted early by a workspace administrator or by whoever opened it, and
never by anybody else. Every transition is audited, including the deletion,
whose audit row carries the thread's title and its decision page so the log
still shows what happened.

Message bodies are other people's and other agents' words. They are shown as the
text somebody typed, never rendered as Markdown and never folded into a page,
and the tools that return them say plainly that they are data to read rather
than instructions to follow.

## Editing together

Opening a page's editor joins that page's **live session**. If somebody else is
already editing, you see their cursor, labelled with their name, and their edits
as they type; if nobody is, you are simply editing. There is nothing to turn on
and nobody is ever told the page is locked by a colleague.

What is stored is still Markdown, and still the page's own bytes. The shared
document is a CRDT bound to the visual editor; when somebody saves, their
browser writes it out with the same bridge that opens an agent's page and saves
it unchanged, so a table or a list nobody touched comes back exactly as it was,
whoever was in the session and whenever they joined.

**Agents see one writer.** The session holds a single claim for everybody in
it, under an identity of its own and labelled with their names. An agent that
tries to claim the page gets the `CONFLICT` it has always got — now naming the
session — and an agent never joins one. So the rule the product is built on
holds: at any moment a page is being written by people *or* by an agent, never
both, and nobody's write is lost to the other's.

- **Saving** is an ordinary write by whoever pressed the button: a revision
  under their name, validated, audited and reviewable like any other. Text is
  also saved for its author after a minute of quiet, and unsaved text survives a
  restart or the last person closing the tab — the next person in finds it.
- **A forgotten tab cannot hold a page.** A session nobody has typed in for five
  minutes, with nothing unsaved, gives the page back and pauses; typing takes it
  back. If an agent wrote the page in the meantime, the session is reset and
  asks everybody to load the page again, rather than merging edits to a text
  that no longer exists.
- **The Markdown tab** is yours while you are alone in the session. With
  somebody else in it, it shows the page and is not typed in — two people cannot
  type into one text box — and the Visual tab is where you work together.
- A page the visual editor cannot keep byte for byte is edited as Markdown by
  one person at a time, under an exclusive lease, as before.

It needs nothing from your deployment. The session runs over server-sent events
and ordinary requests (`/api/v1/pages/{id}/collab`), not a WebSocket: no second
process, no second port, and no proxy configuration beyond passing streamed
responses unbuffered, which the examples above already do. Sessions live in the
application process, so they assume one application process per instance —
which is what `docker compose up` runs.

## Reviewing what agents changed

An agent does not ask before it writes, so the review comes afterwards. Every
version of a page is kept, the author of each is known, and the newest version
that a person wrote — or accepted — is the page's **baseline**. Agent revisions
after the baseline are *pending*. Nothing is flagged or queued in front of the
write; pending is worked out from the history, so editing a page yourself
settles whatever agents did before your edit, and a page an agent created is
pending from its first version.

**Changes**, in the sidebar of every space, lists the pages with pending
revisions — one row per page, with lines added and removed — and shows how many
there are. A pending page also says so above its text. Opening a row shows the
baseline against the page as it stands, line by line, with the changed words
marked inside a rewritten line; however many times the agent wrote, it is one
thing to read. Then:

- **Accept** leaves the page as it is and takes it off the list.
- **Revert** writes the baseline back as a new version under your name. Nothing
  is removed from the history. The write goes through the claim protocol, so a
  page an agent is holding right now is refused with their name instead of being
  pulled out from under them.

Either way you can leave a note, and agents can read it — `GET
/api/v1/pages/{id}/review` returns the decisions with their notes, which is how
an agent finds out why its change was reverted. **All changes** is the same
space as a feed of every revision, by people and agents alike, each marked
`pending`, `accepted`, `reverted`, `edited` (a person wrote over it) or nothing
at all for a person's own revision. Any two versions of a page can be compared
from its **Version history**.

Only people review. An agent token can read all of the above and is refused
with `403 forbidden` when it tries to decide, whatever its scopes.

**Comments on paragraphs** are how a reviewer says *where* the problem is. Point
at a paragraph of a page and press the **+** beside it; the comment, and any
replies, appear under the text, and the paragraph is tinted with the number of
open comments next to it. A comment is attached to the paragraph's text rather
than to its position: it follows the paragraph through edits elsewhere on the
page, and the moment the paragraph itself is rewritten the comment is marked as
being about text that has changed — it is never moved to whatever took the
paragraph's place. That is usually what you want to see after asking an agent
to fix something: the comment, the agent's reply saying what it changed, and the
old wording struck through.

Agents read comments with `wiki.list_comments` — for a whole space before
starting work, or for one page — answer them with `wiki.post_comment`, and open
their own by quoting the passage they mean. A person may resolve any thread; an
agent may resolve only a thread an agent opened, so "resolved" never means that
the agent under review says it is fine. Comments stay with the page, resolved
ones included; they draw on the same per-actor rate limit as discussion
messages, and bodies are shown as the text somebody typed, never as Markdown.

## Inbox

**Inbox**, in the header, is where an answer finds the one who asked. It lists
what other people and agents said or decided, in the last 30 days, about things
you had a hand in:

- a message in a discussion you opened or spoke in, and that discussion being
  resolved — with a link to the decision page when one was written;
- a reply in a comment thread you started or answered;
- a new comment on a page *as you left it* — on the version you wrote;
- a review, accepting or reverting, of changes that include yours.

Never your own actions. The number beside **Inbox** counts what arrived since
you last pressed **Mark all read**, which marks everything up to the moment the
page was rendered — what came in while you were reading stays new.

Agents have the same inbox: `wiki.check_inbox` and `wiki.mark_inbox_read`, and
the onboarding prompt tells an agent to look at the start of a session. That is
what makes a discussion worth opening for an agent — it no longer has to list
every space's threads to learn that it was answered — and what lets a reviewer
see that an agent replied without reopening the page.

Nothing here is stored as a notification. The inbox is read, when you open it,
from the discussions, comments and reviews themselves, in the spaces you can see
at that moment: a discussion that has been cleaned up is gone from it, and so is
everything from a restricted space you are no longer a member of. There is no
e-mail and no push.

## From the UI

Sign in and pick a space on the home page (or from **Go to space** in the
header). **New page**, above the space's page tree, asks where the page goes,
its title, kind and body; **Add child page** on any page does the same with
that page already chosen as the parent:

- **Parent page** is picked from the space's tree, so a subsection is made by
  choosing its section rather than by typing a path. Leave it empty for a
  top-level section. Moving a page to another parent later moves everything
  below it. **Move** on a page takes it, with everything below it, to another
  space: history, comments and pending reviews go along, anchors are checked
  against the new space's repository from then on, and who can read the pages
  becomes whoever can see that space.
- **Kind** is `technical` or `human`. The two are the linked document pair:
  one written for agents, one written for people. A page of each kind can be
  paired so that a reader of either lands on the other.
- **URL segment** is optional and built from the title — a page called "Auth
  service" under `/backend` becomes `/backend/auth-service`, and the form shows
  the resulting path before you save. A title with no Latin letters needs a
  segment typed in.
- **Body** is edited on the **Visual** tab, like a word processor, or on the
  **Markdown** tab as source — the page is stored as Markdown either way.
  Type `/` for a block: headings, lists and task lists, tables, callouts,
  code blocks, images — uploaded from the **Image** dialog, pasted as a
  screenshot, dropped as a file, or given by address — Mermaid diagrams from
  a template, and charts drawn from a table of data. A page opened and saved
  without edits is stored byte for byte as it was, and an edit rewrites only
  the blocks it touched; a page the editor cannot promise that for opens on the
  Markdown tab and says so. The same constructs in Markdown:

  ````markdown
  > [!WARNING]
  > Deleting a page removes everything below it.

  | Service | p95 (ms) |
  | :--- | ---: |
  | API | 120 |

  ```mermaid
  flowchart LR
      Agent -->|writes| Page
      Page -->|revision| History
  ```

  ```chart
  { "type": "bar", "x": ["API", "Worker"], "series": [{ "name": "p95", "data": [120, 300] }], "unit": "ms" }
  ```
  ````

  A chart or Mermaid block that does not validate is not saved: the form lists
  each problem with its block, line and field, the answer an agent gets as
  `VALIDATION`.

**Show preview** on the Markdown tab renders the body through the same pipeline
the stored page and the HTML export use, so the preview cannot show you
something the page will not.

Opening the editor takes a claim on the page and holds it — the editor
heartbeats while the form is open and gives the claim back when you save or
leave. If somebody else, or an agent, is already holding the page, the editor
says who and since when and offers the page read-only instead. It is the same
lease an agent takes over REST, through the same service: a person and an agent
contend for a page the same way rather than through two mechanisms that have to
be kept in agreement.

## From an agent token

Issue a token with `pages:read` and `pages:write` ([Deploy](deploy.md#quick-start), step
7), then:

```sh
export CLEWWIKI_TOKEN=cww_…
export CLEWWIKI_URL=http://localhost:3000

# Which spaces can this token reach?
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" "$CLEWWIKI_URL/api/v1/spaces"

# Create a page in one of them.
curl -sS -X POST "$CLEWWIKI_URL/api/v1/pages" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{
           "space": "API",
           "title": "Auth service",
           "path": "/backend/auth",
           "kind": "technical",
           "summary": "How bearer tokens are verified.",
           "body": "# Auth service\n\nTokens are verified before any handler runs.\n"
         }'
```

```json
{
  "page_id": "3f0c…",
  "space": { "key": "API", "name": "Public API" },
  "path": "/backend/auth",
  "title": "Auth service",
  "kind": "technical",
  "version": 1,
  "content_hash": "9f2b…",
  "updated_by": { "type": "agent", "id": "1ced…" },
  "anchors": []
}
```

A page by path is looked up inside a space —
`GET /api/v1/pages?space=API&path=/backend/auth` — because paths are unique per
space. Creating a space is an administrator's act, from the UI or with
`POST /api/v1/spaces` from a signed-in session; no agent token can do it.

## Claim, write, release

A write needs two things: a **claim** — a lease on the page, or on a named
section of it — and the **content hash** the caller last read. The claim means
nobody else may write there; the hash proves nobody did. Neither is optional,
and both are checked inside the same database transaction that performs the
write.

```sh
# 1. Take the lease. 201 means it is yours.
curl -sS -X POST "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/claims" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"ttl_seconds": 600}'
```

```json
{
  "claim_id": "8b41…",
  "page_id": "3f0c…",
  "held_by": "ci-writer",
  "actor_type": "agent",
  "since": "2026-05-04T09:12:11.004Z",
  "expires_at": "2026-05-04T09:22:11.004Z",
  "base_content_hash": "9f2b…"
}
```

If somebody else already holds the page, the answer is `409` and it names
them, so a second agent can wait instead of guessing:

```json
{
  "error": {
    "code": "conflict",
    "message": "This page is claimed by someone else",
    "details": {
      "claim_id": "0d7a…",
      "held_by": "Dana",
      "actor_type": "user",
      "since": "2026-05-04T09:10:02.881Z",
      "expires_at": "2026-05-04T09:20:02.881Z"
    }
  }
}
```

```sh
# 2. Write under the lease. The hash is the one the claim (or the last read)
#    handed back.
curl -sS -X PATCH "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d "{\"body\": \"# Auth service\n\nRewritten.\n\",
          \"claim_id\": \"$CLAIM_ID\",
          \"base_content_hash\": \"$HASH\"}"

# 3. Heartbeat while the work is still going — a lease that stops being
#    renewed lapses, so a crashed client cannot hold a page forever.
curl -sS -X PATCH "$CLEWWIKI_URL/api/v1/claims/$CLAIM_ID" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' -d '{}'

# 4. Give it back.
curl -sS -X DELETE "$CLEWWIKI_URL/api/v1/claims/$CLAIM_ID" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN"
```

A write whose `base_content_hash` no longer matches is refused with
`409 stale_base`, carrying both hashes, even when the claim itself is
perfectly valid — someone with a section claim, or an administrator, may have
written in between. The caller re-reads, merges, and writes again; the server
never merges on anyone's behalf:

```json
{
  "error": {
    "code": "stale_base",
    "message": "Page has changed since it was read",
    "details": { "current_content_hash": "c41e…", "your_base_hash": "9f2b…" }
  }
}
```

A claim can cover one named section instead of the whole page, which is what
lets two writers work on one document at the same time:

```sh
curl -sS -X POST "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/claims" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"section_id": "api-reference"}'
```

Two section claims coexist while they name different sections. A page-level
claim excludes every section claim on that page, and every section claim
excludes a page-level one.

A section claim controls *who may write*, not *which bytes they may write*:
the server does not check a body against section boundaries, so a write under
a section claim still replaces the whole body.
Two holders of different sections writing at once are separated by the content
hash instead — the second one is refused with `stale_base`, re-reads, and
writes again. Nothing is lost either way.

## Presence and notes

`GET /api/v1/claims` answers with every claim held right now, in every space the
caller can see — or in one, with `?space=API`.
The same data is on the **Presence** page in the UI, refreshed every ten
seconds, with a badge in the page tree and in the page header so a reader sees
that a page is spoken for before opening the editor.

```sh
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" "$CLEWWIKI_URL/api/v1/claims"
```

```json
{
  "claims": [
    {
      "claim_id": "8b41…",
      "page_id": "3f0c…",
      "space": { "key": "API", "name": "Public API" },
      "path": "/backend/auth",
      "section_id": "api-reference",
      "held_by": "ci-writer",
      "actor_type": "agent",
      "since": "2026-05-04T09:12:11.004Z",
      "expires_at": "2026-05-04T09:22:11.004Z",
      "notes": [
        {
          "note_id": "af02…",
          "text": "Rewriting the API reference, leave Overview alone.",
          "author": "ci-writer",
          "created_at": "2026-05-04T09:12:40.119Z"
        }
      ]
    }
  ]
}
```

A note says what its author is doing while an edit is in flight. It hangs on a
claim, it is never part of the page's history, and it is deleted the moment the
claim ends — by release, by expiry, or by an administrator:

```sh
curl -sS -X POST "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/notes" \
     -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d "{\"claim_id\": \"$CLAIM_ID\", \"text\": \"Rewriting the API reference.\"}"
```

Notes are text somebody wrote, shown with their name and timestamp. Like page
bodies, they are data — nothing that reads them treats them as instructions.

**When a lease outlives its holder.** Claims expire on their own: the TTL
defaults to ten minutes, a caller may ask for anything between one second and
one hour, and a workspace can set its own default. Until then a stuck claim can
be taken away by a workspace administrator, from the presence board or with
`DELETE /api/v1/claims/{claimId}?force=true`. That is an administrator-only
action and it is written to the audit log under its own name. Agent tokens
cannot force-release anything, whatever scopes they carry.

Search, history and the tree:

```sh
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/search?q=bearer&space=API&limit=5"
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/versions"
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/tree"
```

## Export

Every page exports to Markdown or HTML, from the **Export** menu on the page or
straight from the API. Both are rendered from the page itself with nothing
fetched at export time, so an export keeps working when everything around it
does not:

```sh
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/export/$PAGE_ID?format=md" -o auth.md

curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/export/$PAGE_ID?format=html" -o auth.html
```

The Markdown file is the body exactly as stored, under front matter carrying
the title, space, path, kind, version, content hash and modification time.

A whole space exports as a ZIP of those Markdown files, with folders mirroring
the page tree — `API/backend.md`, `API/backend/auth.md`:

```sh
curl -sS -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/spaces/API/export?format=md" -o API.zip
``` The HTML
file is a standalone document that opens from disk with nothing to load.
Charts are drawn into it as inline SVG and callouts are styled, so both show
and print with scripting off. Mermaid blocks are kept as `<pre class="mermaid">`
holding their source, since drawing them would mean shipping a renderer inside
every exported file; to print a diagram, print the page view in the application
once its diagrams have drawn.

**PDF.** There is no PDF export format. Open the HTML export in a browser and
print it to PDF: the file carries its own print stylesheet — page margins, no
dark background, code blocks wrapped instead of cut off, tables and code kept
off page breaks where they fit — so the printed copy reads as a document rather
than a screenshot of a web page. Rendering PDFs on the server would mean a
headless browser in the image, several hundred megabytes for one convenience;
`docs/roadmap.md` records the measurement behind that decision.

## Anchoring a page to code

An anchor ties a page, or one named section of it, to a declaration in your
source repository. When the code changes, the page is flagged — it is never
rewritten, and nothing is trusted silently.

**Link a repository once per space, as an administrator.** Each space has its
own, because each project has its own code. Open the space, then **Space
settings**, and fill in three fields under *Linked repository*:

| Field | What it takes |
|---|---|
| Repository URL | `https://…`, without a user name or token in it. `file:///srv/checkouts/api` for a checkout mounted into the container works only with `ALLOW_FILE_REPOSITORIES=true`. `git://`, `ext::` and anything starting with `-` are refused. The container image ships no SSH client, so use `https://` with an access token rather than `ssh://`. |
| Default ref | The branch, tag or commit anchors are checked against unless a caller names another. Usually `main`. |
| Access token variable | The **name** of the environment variable holding the token: `CLEWWIKI_GIT_TOKEN`, or `CLEWWIKI_GIT_TOKEN_<NAME>`. No other name is accepted. Leave it empty for a public or local repository. |

The token itself is never typed into the form and never stored: the setting
records the variable's name, and the server reads the value out of its own
environment when it talks to git, and sends it only to the `https://` origin of
the repository. **Test connection** checks the URL, the ref and the token
without cloning anything, and is recorded in the audit log as
`space.repository_tested`; saving is recorded as `space.repository_set`.
Administrators can set it over REST too, with `repository` in
`PATCH /api/v1/spaces/{key}`.

The server keeps a read-only bare mirror per space under `REPOS_DIR`,
fetches it on demand, and reads files with `git show`. It never creates a
working tree, never runs a build, an install script or a hook, and never
executes anything it finds in your repository.

**Add an anchor** from the *Anchored code* panel on any page — a file path plus
either a symbol (`Mixer.blend(first:second:)`) or a line range (`42-58`) — or
over the API:

```sh
curl -sS -X POST -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"file":"Sources/Audio/Mixer.swift","qualified_name":"Mixer.blend(first:second:)"}' \
     "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/anchors"
```

The declaration is resolved against the repository before the anchor is stored,
so a misspelled symbol is refused there and then rather than reported as `lost`
a week later. Swift, TypeScript, TSX and Kotlin have declaration tables today; any
other file can still be anchored by line range. A Kotlin function is named with
its parameter names, `Checkout.pay(items)`, which is what tells overloads apart;
an extension carries its receiver, `String.slug()`; and a companion's members
are members of the class, `Checkout.create(gateway)`.

**Check** recomputes every anchor on a page against the repository and stores
the result, so it is a `POST` and needs `pages:write`:

```sh
curl -sS -X POST -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     -H 'Content-Type: application/json' -d '{"ref":"main"}' \
     "$CLEWWIKI_URL/api/v1/pages/$PAGE_ID/anchors/check"
```

A `GET` on the same path, with `pages:read`, returns the states the last check
stored without touching the repository. A check reads at most 2 000 files and
32 MB of source in 30 seconds; when it runs out, the response says
`"complete": false`, names the limit in `budget.limit`, and lists the anchors it
could not place in `unchecked_anchor_ids` — those keep their previous state
rather than being marked `lost`.

Each anchor comes back in one of four states, and they mean different things:

| State | What happened | What to do |
|---|---|---|
| `fresh` | The declaration is there and unchanged. | Nothing. |
| `stale` | Same declaration, changed body. | Read the diff, update the page, confirm. |
| `moved-renamed` | The declaration was found elsewhere, or under another name. The response says where and what it is called now. | Confirm, which re-points the anchor. |
| `lost` | Nothing resolvable. | A decision, not an edit: fix the page, or delete the anchor. |

A formatting change does not flag anything. The hash covers the parser's token
sequence rather than the file's text, so re-indenting a function, wrapping its
arguments or rewriting its comments changes nothing the checker looks at; a
change to what the code *does* changes the hash.

**Confirm** is the only thing that clears a flag, and it is a deliberate,
audited act by a person or an agent:

```sh
curl -sS -X POST -H "Authorization: Bearer $CLEWWIKI_TOKEN" \
     "$CLEWWIKI_URL/api/v1/anchors/$ANCHOR_ID/confirm"
```

The check response also carries `fallback_share` — the share of the space's
anchors sitting on the line-range path. Line ranges do not survive an edit above
them, so a rising number is the early warning that the badges are turning into
noise.
