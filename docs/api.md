# REST API


| Endpoint | Auth | Scope | Purpose |
|---|---|---|---|
| `GET /api/v1/health` | none | — | Liveness and database reachability. Used by the compose healthcheck. |
| `GET /api/v1/me` | session or token | `identity:read` | Who the caller is, what it may do, which workspace it is bound to, and which spaces it can reach (`space_access`). |
| `GET /api/v1/format-guide` | session or token | `pages:read` | The page format reference: Markdown constructs with examples, Mermaid keywords and templates, the chart block schema, limits and an example per chart type, and the validation error shape. |
| `GET /api/v1/spaces` | session or token | `pages:read` | The spaces the caller can reach, with page counts. `include_archived=true` adds archived ones. |
| `POST /api/v1/spaces` | admin session | — | Create a space: `key`, `name`, `description`, `icon`. `409` when the key is taken. |
| `GET /api/v1/spaces/{key}` | session or token | `pages:read` | One space. The repository link is shown in full to administrators only. |
| `PATCH /api/v1/spaces/{key}` | admin session | — | Change `name`, `description`, `icon`, `home_page_id`, `rules_page_id` or `repository`. The key cannot be changed. |
| `POST /api/v1/spaces/{key}/archive`, `…/unarchive` | admin session | — | Archive a space, or bring it back. |
| `GET /api/v1/spaces/{key}/rules` | session or token | `pages:read` | The space's working rules: the designated page's id, path, title, content hash, body and timestamp. `404` when no page is designated. |
| `GET /api/v1/spaces/{key}/skills` | session or token | `pages:read` | The space's skills without their bodies: slug, name, description, version, tags, updated. Takes `tag`. |
| `POST /api/v1/spaces/{key}/skills` | session or token | `pages:write` | Create a skill. The body may be a whole `SKILL.md`; front matter that does not parse is `400 validation` naming the field and the line. |
| `GET /api/v1/spaces/{key}/skills/{slug}` | session or token | `pages:read` | One skill in full: body, assembled `SKILL.md`, and the install command. |
| `PATCH /api/v1/spaces/{key}/skills/{slug}` | session or token | `pages:write` | Change a skill. Fields left out keep their stored values. |
| `DELETE /api/v1/spaces/{key}/skills/{slug}` | session or token | `pages:write` + `pages:delete` | Remove a skill. The slug becomes free again. |
| `GET /api/v1/spaces/{key}/export` | session or token | `pages:read` | The whole space as a ZIP of Markdown files mirroring the tree. Takes `format=md`. |
| `POST /api/v1/spaces/{key}/imports` | admin or editor session | — | Start an import. JSON for Confluence (`base_url`, `space_key`, `email`, `api_token` — the last two are used once and never stored); `multipart/form-data` with `source` and `file` for a Notion ZIP, a Markdown ZIP or a PDF. Answers `201` with the import in `needs_review`; nothing is written to pages. `413` when the declared `Content-Length` is over 200 MB and `411` when it is absent; `400 validation` for a Confluence address that is not a public `https` host. Refused to agent tokens. |
| `GET /api/v1/spaces/{key}/imports` | admin or editor session | — | The imports of a space, newest first. |
| `GET /api/v1/imports/{id}` | admin or editor session | — | One import: status, counts, and every staged item with its target path, warnings, converted Markdown, the page already at that path, and who holds a claim on it. |
| `PATCH /api/v1/imports/{id}/items/{itemId}` | admin or editor session | — | The reviewer's edit: `decision` (`create`, `skip`, `overwrite`) and `target_path`. `409` once the import is no longer open for review, or when another item already targets that path. |
| `POST /api/v1/imports/{id}/apply` | admin or editor session | — | Create the pages. Answers with what landed and what was skipped, with the reason — a taken path or somebody else's claim. |
| `POST /api/v1/imports/{id}/cancel` | admin or editor session | — | Close an import without applying it. |
| `DELETE /api/v1/imports/{id}` | admin or editor session | — | Remove the import and its staged items. Pages it created stay. |
| `GET /api/v1/spaces/{key}/discussions` | session or token | `pages:read` | The space's discussions, newest activity first. Takes `status` (`open`, `resolved`). Each carries its message count, participants, the page it is about, and when it will be closed or deleted. |
| `POST /api/v1/spaces/{key}/discussions` | session or token | `pages:write` | Open a discussion with its first message: `title`, `body`, optional `page_id` and `section_id`. `400 validation` when the space already has 100 open. |
| `GET /api/v1/discussions/{id}` | session or token | `pages:read` | One discussion with every message, oldest first. |
| `POST /api/v1/discussions/{id}/messages` | session or token | `pages:write` | Add a message, pushing the closing deadline out. `409 conflict` on a resolved thread, `400 validation` past 200 messages or 8 KB, `429 rate_limited` past the per-actor message budget. |
| `POST /api/v1/discussions/{id}/resolve` | session or token | `pages:write` | Resolve with a decision: `decision` (required), `context`, `options`, `consequences`, `locale`. Creates or rewrites the decision page and answers with it. |
| `DELETE /api/v1/discussions/{id}` | session or token | `pages:write` | Remove a discussion and its messages early. Administrator or the opener only. The decision page is kept. |
| `GET /api/v1/spaces/{key}/members` | admin session | — | The people a restricted space is visible to, with names and e-mail addresses. Workspace administrators are not listed unless somebody added them: they see every space regardless. `403 forbidden` for an editor and for any agent token. |
| `PUT /api/v1/spaces/{key}/members` | admin session | — | Replace the member list, whole: `{ "user_ids": [...] }`. Only people of this workspace; an id from anywhere else is `400 validation` naming it, rather than dropped. Does not restrict the space — `PATCH /api/v1/spaces/{key}` with `restricted: true` does. |
| `GET /api/v1/pages` | session or token | `pages:read` | The page tree, without bodies. Takes `space`, `parent_id`, `path` (needs `space`), `kind`, `depth`; without `space`, the top of every space. |
| `POST /api/v1/pages` | session or token | `pages:write` | Create a page. Requires `space`. An invalid ` ```chart ` or ` ```mermaid ` block in the body is `400 validation` with `block_index`, `line` and `errors`. |
| `GET /api/v1/pages/{id}` | session or token | `pages:read` | One page with its body, content hash and linked counterpart. |
| `PATCH /api/v1/pages/{id}` | session or token | `pages:write` | Update or move a page under a claim. Requires `claim_id` and `base_content_hash`. Writes a revision and bumps the version. A changed body is held to the same chart and diagram validation as a new page. |
| `DELETE /api/v1/pages/{id}` | session or token | `pages:write` + `pages:delete` | Soft-delete a page and everything below it. `409 conflict` while another actor holds a live claim in the subtree, unless the caller is an administrator. |
| `GET /api/v1/pages/{id}/images` | session or token | `pages:read` | The images uploaded into a page, newest first, without their bytes. |
| `POST /api/v1/pages/{id}/images` | session or token | `pages:write` | Upload an image. The request body is the image itself (`Content-Type: image/png`, `image/jpeg`, `image/gif` or `image/webp`, with `Content-Length`); what it is gets decided from its bytes. Answers the relative `url` to use in a page body. Takes no claim: an image shows nowhere until a write refers to it. The same bytes again answer `200` with the image already stored. `413` past `IMAGE_MAX_UPLOAD_MB`, `409 conflict` when the workspace's store is full, `403` when uploads are off. |
| `POST /api/v1/spaces/{key}/images` | session or token | `pages:write` | Upload an image for a page that does not exist yet. Only its uploader can see it until they create a page in that space whose body refers to it; then it is the page's. Removed after a day if no page claims it. |
| `GET /api/v1/images/{imageId}` | session or token | `pages:read` | The image, to whoever can see its page. Served as the detected type only, with `nosniff`, a sandboxing `Content-Security-Policy` and `Cross-Origin-Resource-Policy: same-origin`, and always revalidated (`ETag`, `304`). `404` for an image of a deleted page. |
| `DELETE /api/v1/images/{imageId}` | session or token | `pages:write` + `pages:delete` | Remove an image for good. Revisions that refer to it keep their text and lose the picture. |
| `POST /api/v1/pages/{id}/move` | session or token | `pages:write` + `pages:delete` | Move a page and everything below it to another space: `space`, and `parent_id` or `parent_path` in it (neither means top level). The caller must see both spaces. Content, versions, comments and pending reviews are untouched; a pair that would span two spaces is unpaired and listed in `unlinked_page_ids`. `409 conflict` while another actor holds a live claim in the subtree, when the target has a page at one of the paths or is archived, and while the source space uses one of the pages as its home, rules or decisions page. A move inside a space is a `PATCH` with `parent_id` or `path`. |
| `POST /api/v1/pages/{id}/restore` | admin session | — | Restore a soft-deleted page and the subtree deleted with it. `409 conflict` when a live page has taken one of its paths or its parent is gone or moved. |
| `GET /api/v1/pages/{id}/tree` | session or token | `pages:read` | The subtree rooted at a page, nested. |
| `GET /api/v1/pages/{id}/collab` | session | — | Join the page's live editing session and stream it as server-sent events: `hello` (the document so far, who is present, whether the session holds the page), `update`, `awareness`, `participants`, `saved`, `status`, `reset`. Takes `client` (a UUID for this connection) and `y` (the Yjs client id). `403 forbidden` for any agent token; `409 conflict` when the session or the instance is full. |
| `POST /api/v1/pages/{id}/collab` | session | — | What a browser in the session sends, as JSON with a `kind`: `update`, `seed`, `awareness`, `resume` or `save` (`body`, `state_vector`, optional `title` and `summary`). Only from a connection that joined, as the person who joined — `404` otherwise. `409 conflict` while somebody else holds the page; `403` for a cursor that is not the sender's own. |
| `GET /api/v1/pages/{id}/versions` | session or token | `pages:read` | Revision history: version, author, content hash, timestamp. |
| `GET /api/v1/pages/{id}/versions/{version}` | session or token | `pages:read` | One version of a page with its body. `404 not_found` for a version the page never had. |
| `GET /api/v1/pages/{id}/diff` | session or token | `pages:read` | The difference between two versions as hunks of numbered lines, with changed words marked inside rewritten lines. Takes `from` (0 means "before the page existed"), `to` (defaults to the current version) and `context` (0–50, default 3). `coarse: true` when the versions are too far apart for a minimal diff. |
| `GET /api/v1/pages/{id}/review` | session or token | `pages:read` | Where a page stands with its reviewers: `baseline_version`, `pending`, the pending agent revisions, and the decisions recorded so far with their notes. |
| `POST /api/v1/pages/{id}/review` | session | — | Record a decision: `decision` (`accept` or `revert`), `version` (the version you looked at) and an optional `note`. `403 forbidden` for any agent token. `409 stale_base` when the page has changed since, `409 conflict` when nothing is pending, when there is no baseline to revert to, or when somebody holds a claim on the page. |
| `GET /api/v1/spaces/{key}/reviews` | session or token | `pages:read` | The pages of a space with agent changes no person has looked at, most recently changed first, one entry per page with `revision_count`, `authors`, `lines_added` and `lines_removed`. |
| `GET /api/v1/spaces/{key}/changes` | session or token | `pages:read` | The change feed: every revision in the space, newest first, with its author and `review_status`. Takes `limit`, `author` (`user`, `agent`) and `before` — pass back `next_before` to page. |
| `GET /api/v1/pages/{id}/comments` | session or token | `pages:read` | The comment threads of a page with their replies. Takes `status` (`open`, `resolved`, `all`). Each thread's `anchor.state` says where it points now: `current` with `line_start`/`line_end`, `outdated`, or `page`. |
| `POST /api/v1/pages/{id}/comments` | session or token | `pages:write` | Open a thread: `body`, and either `block_index` (with `version`, counting the blocks of that version) or `quote` (a passage of the body identifying one paragraph), or neither for the page as a whole. `400 validation` for a quote found nowhere or in several paragraphs, or past 200 open threads; `429 rate_limited` past the per-actor message budget. |
| `POST /api/v1/comments/{id}/replies` | session or token | `pages:write` | Reply in a thread. `409 conflict` on a resolved thread, `400 validation` past 100 replies or 8 KB. |
| `PATCH /api/v1/comments/{id}` | session or token | `pages:write` | Resolve or reopen: `{ "resolved": true }`. `403 forbidden` for an agent token on a thread a person opened. |
| `DELETE /api/v1/comments/{id}` | session or token | `pages:write` | Remove a comment, and its replies if it opens a thread. Its author or a workspace administrator. |
| `GET /api/v1/spaces/{key}/comments` | session or token | `pages:read` | The comment threads of a space, newest first, each with its page. Takes `status` (default `open`) and `limit`. |
| `POST /api/v1/pages/{id}/link` | session or token | `pages:write` | Pair a technical page with a human one of the same space, or unpair them. |
| `POST /api/v1/pages/{id}/claims` | session or token | `pages:write` | Take a claim on the page, or on a section of it. `201` when granted, `200` when it extends a lease the caller already held, `409` when someone else holds it. |
| `GET /api/v1/pages/{id}/claims` | session or token | `pages:read` | The live claims on one page. |
| `PATCH /api/v1/claims/{claimId}` | session or token | `pages:write` | Heartbeat: extends a lease the caller holds. |
| `DELETE /api/v1/claims/{claimId}` | session or token | `pages:write` | Release a claim and delete its notes. Idempotent. `?force=true` is administrator-only. |
| `GET /api/v1/claims` | session or token | `pages:read` | The presence board: every live claim, with its notes and space. Takes `space`. |
| `POST /api/v1/pages/{id}/notes` | session or token | `pages:write` | Leave an ephemeral note on a claim the caller holds. |
| `GET /api/v1/pages/{id}/notes` | session or token | `pages:read` | The active notes on a page. |
| `POST /api/v1/pages/{id}/anchors` | session or token | `pages:write` | Anchor the page, or one of its sections, to a declaration or a line range. Resolves it against the repository first. |
| `GET /api/v1/pages/{id}/anchors` | session or token | `pages:read` | The anchors on one page, plus the space's `fallback_share`. |
| `GET /api/v1/pages/{id}/anchors/check` | session or token | `pages:read` | The anchor states the last check stored, without touching the repository. |
| `POST /api/v1/pages/{id}/anchors/check` | session or token | `pages:write` | Recompute every anchor on the page against the repository, within a read budget. Takes `ref`. |
| `POST /api/v1/anchors/{anchorId}/confirm` | session or token | `pages:write` | Clear a flag after review, re-baselining the anchor onto what is there now. |
| `DELETE /api/v1/anchors/{anchorId}` | session or token | `pages:write` | Remove an anchor. |
| `GET /api/v1/audit` | admin session or token | `audit:read` | The audit log, newest first. Takes `action`, `target`, `since`, `limit`. Refused to a token limited to some spaces. |
| `GET /api/v1/search` | session or token | `pages:read` | Full-text search. Takes `q`, `space`, `limit`, `kind`; without `space`, every unarchived space the caller can see. |
| `GET /api/v1/export/{id}` | session or token | `pages:read` | Export a page. Takes `format=md` or `format=html`. |

A browser session can call these endpoints too, but a request that changes
state must then come from the instance's own origin (`Origin` equal to
`BETTER_AUTH_URL`, or `Sec-Fetch-Site: same-origin`) and carry
`Content-Type: application/json`; anything else is `403 forbidden`. The one
exception is the import upload, which cannot be JSON: it takes
`multipart/form-data` and requires a matching `Origin` header outright, rather
than accepting `Sec-Fetch-Site` in its place. Requests with an agent token are
not affected.

All of them refuse to answer for a workspace other than the caller's own — and,
for a token limited to some spaces, for a space outside its list — with `404`
rather than `403` so the response does not confirm that a page exists
somewhere else. That check is written explicitly in each handler rather than
inferred from there being one workspace, so it does not have to be retrofitted
when there is more than one. Errors share one envelope:

```json
{ "error": { "code": "stale_base", "message": "…", "details": { } } }
```

The codes are `validation`, `not_found`, `conflict`, `stale_base`,
`forbidden`, `insufficient_scope`, `unauthenticated`, `invalid_token`,
`rate_limited` and `repository_unavailable`. A `repository_unavailable` carries
a fixed message only; git's own output, which the remote server writes, goes to
the server log. On the write path they mean
particular things: `conflict` is
"you have no claim here", `not_found` on a write is "your claim has expired or
been released", `forbidden` is "that claim belongs to someone else", and
`stale_base` is "the page moved under you". `repository_unavailable` is a `502`:
the space's source repository could not be reached or read, which is this
instance's dependency failing rather than anything wrong with the request.
