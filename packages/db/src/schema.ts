import { isNull, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Account roles inside a workspace. Agent tokens are not users and carry
 * their own scope list instead of a membership role.
 */
export const membershipRole = pgEnum('membership_role', ['admin', 'editor']);

/** Who performed an audited action. */
export const actorType = pgEnum('actor_type', ['user', 'agent']);

/**
 * The two linked document types. A page is written either for a person or for
 * an agent; the pair is joined through `pages.linked_page_id`.
 */
export const pageKind = pgEnum('page_kind', ['technical', 'human']);

/**
 * Why an active claim stopped being active. `released` is the holder letting
 * go, `expired` is the TTL running out, `forced` is an administrator taking it
 * away — the three are kept apart because they mean different things when the
 * audit log is read back.
 */
export const claimReleaseReason = pgEnum('claim_release_reason', [
  'released',
  'expired',
  'forced',
]);

/**
 * How an anchor stood at its last check.
 *
 * Four values rather than one boolean, because the three failure modes ask
 * different things of a reader: `stale` is a diff to read, `moved-renamed` is a
 * re-anchor, and `lost` is a decision about whether the documentation still
 * describes anything.
 */
export const anchorState = pgEnum('anchor_state', ['fresh', 'stale', 'moved-renamed', 'lost']);

/** Where an import's content came from. */
export const importSource = pgEnum('import_source', ['confluence', 'notion', 'markdown', 'pdf']);

/**
 * How far an import has got.
 *
 * `needs_review` is the state that matters: parsing has finished, the items are
 * staged, and nothing has been written to `pages`. Every import stops there and
 * waits for a person, whichever source it came from.
 */
export const importStatus = pgEnum('import_status', [
  'pending',
  'running',
  'needs_review',
  'applied',
  'failed',
  'cancelled',
]);

/** What a reviewer decided about one staged item. */
export const importDecision = pgEnum('import_decision', ['create', 'skip', 'overwrite']);

/**
 * Where a discussion stands.
 *
 * Two values and no third, because the thread itself is not meant to be
 * archived: it is `open` while people and agents are still talking, `resolved`
 * once the outcome has been written down, and after that it is deleted. What
 * survives is the decision page, which is an ordinary page.
 */
export const discussionStatus = pgEnum('discussion_status', ['open', 'resolved']);

/**
 * What a person decided about the changes an agent made to a page.
 *
 * Two values and no `rejected`: a review happens after the write, so there is
 * nothing to reject — the content is already the page. It is either left as it
 * is, or the page is put back to what it was.
 */
export const reviewDecision = pgEnum('review_decision', ['accepted', 'reverted']);

/** PostgreSQL `bytea`, as the bytes it is. */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  },
  fromDriver(value) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  },
});

/**
 * PostgreSQL `tsvector`. Drizzle has no built-in mapping for it, and the
 * column is never read back into TypeScript — it exists for the index and for
 * the ranking expression — so the driver type is a plain string.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * Per-workspace knobs that are policy rather than structure.
 *
 * They live in one JSON column instead of a settings table: every one of them
 * is read as a whole with the workspace row, none is queried on its own, and a
 * new knob must not be a migration. A value that ever needs an index or a
 * foreign key graduates to a column of its own.
 *
 * The source repository used to live here too. It moved to the space in
 * migration `0004_spaces`, because each project has its own code; the
 * migration copies the value onto the space it creates and removes it from the
 * workspace, and nothing reads it here any more.
 */
export interface WorkspaceSettings {
  /**
   * Default lease length for a claim, in seconds. Absent means the server
   * default (10 minutes); a caller may still ask for a shorter or longer TTL
   * within the bounds the claim service enforces.
   */
  claim_ttl_seconds?: number;
}

/**
 * Per-space knobs, kept as JSON for the same reason as the workspace's: read
 * with the row, queried on their own by nothing.
 */
export interface SpaceSettings {
  /** The source repository this space's anchors are checked against. */
  repository?: RepositorySettings;
  /**
   * How long an open discussion may sit without activity before it is closed
   * automatically, in days. Absent means the server default (14).
   */
  discussion_idle_days?: number;
  /**
   * How long a resolved discussion — and its messages — are kept after it was
   * resolved, in days. Absent means the server default (7). The decision page
   * a resolution produced is a page and is never touched by this.
   */
  discussion_retention_days?: number;
  /**
   * The page decision pages are created under. Absent until the first
   * resolution, which creates `/decisions` in the space and records it here.
   */
  decisions_page_id?: string | null;
}

/**
 * Where the code an anchor points at lives.
 *
 * `auth_token_env` names an environment variable, never a token: a credential
 * written into a settings row would be readable by anything that can read the
 * space, would survive in database backups, and would have to be redacted
 * from every API response that carries settings. The operator sets the variable
 * on the process; the application only ever learns its name.
 */
export interface RepositorySettings {
  /** `https://…`, `ssh://…` or `file://…` for a local or test repository. */
  url: string;
  /** The ref checked by default: a branch name, a tag, or a commit. */
  default_ref: string;
  /** Name of the environment variable holding the access token, if any. */
  auth_token_env?: string;
}

/**
 * Workspaces. v1 seeds exactly one row during first-run setup, but every
 * handler still checks workspace membership explicitly so that adding more
 * rows later is not a refactor.
 */
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  settings: jsonb('settings').$type<WorkspaceSettings>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Authentication tables owned by better-auth                          */
/* ------------------------------------------------------------------ */

export const users = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
});

export const accounts = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Application tables                                                  */
/* ------------------------------------------------------------------ */

/** Binds a human account to a workspace with a role. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('memberships_workspace_user_key').on(table.workspaceId, table.userId),
    index('memberships_user_idx').on(table.userId),
  ],
);

/**
 * Programmatic tokens issued to agents.
 *
 * The secret half of a token is never stored: only its SHA-256 digest is
 * persisted, and lookups happen through the non-secret `prefix` column so the
 * digest can be compared in constant time.
 */
export const agentTokens = pgTable(
  'agent_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull().unique(),
    tokenHash: text('token_hash').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    /**
     * The spaces this token may reach, by id. `null` means every space in the
     * workspace, which is what every token issued before spaces existed has.
     * A list is a restriction the handlers enforce the same way they enforce
     * the workspace: a page in a space outside it answers `404`.
     */
    spaceIds: jsonb('space_ids').$type<string[] | null>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('agent_tokens_workspace_idx').on(table.workspaceId)],
);

/**
 * Append-only record of who did what. Rows are written in the same
 * transaction as the action they describe wherever the action touches the
 * database, so a failed attempt is still forensic signal.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorType: actorType('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('audit_log_actor_idx').on(table.actorType, table.actorId),
  ],
);

/**
 * Spaces: one area of the wiki per project or product, the way Confluence
 * divides a site.
 *
 * Every page belongs to exactly one space, and a page's path is unique within
 * its space rather than within the workspace, so two projects can each have a
 * `/backend`. The key is the short, stable handle people and agents type
 * (`MOBILE`, `API2`): 2–10 uppercase letters or digits, unique per workspace,
 * and never changed after creation, because it is in every URL and every agent
 * prompt that names the space.
 *
 * A space is archived rather than deleted. Its pages stay readable; it drops
 * out of the default listings and takes no new pages.
 */
export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** Short Markdown shown on the space overview and in the space list. */
    description: text('description').notNull().default(''),
    /** One emoji or a few characters. */
    icon: text('icon'),
    /** The page shown as the space overview, when one is chosen. */
    homePageId: uuid('home_page_id').references((): AnyPgColumn => pages.id, {
      onDelete: 'set null',
    }),
    /**
     * The page holding this project's working rules, when one is designated.
     *
     * A page rather than a column of Markdown: rules are written in the same
     * editor as everything else, they get revisions, and a diff of "what the
     * rules used to say" is the whole point of keeping them. The column only
     * says *which* page is the rules page; deleting that page clears it.
     */
    rulesPageId: uuid('rules_page_id').references((): AnyPgColumn => pages.id, {
      onDelete: 'set null',
    }),
    settings: jsonb('settings').$type<SpaceSettings>().notNull().default({}),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /**
     * A restricted space is visible to its members and to workspace
     * administrators, and to nobody else: to everyone else it does not exist,
     * the way a space in another workspace does not. False for every space
     * created before this column, so nothing changes until somebody asks.
     */
    restricted: boolean('restricted').notNull().default(false),
  },
  (table) => [
    uniqueIndex('spaces_workspace_key_key').on(table.workspaceId, table.key),
    check('spaces_key_format', sql`${table.key} ~ '^[A-Z0-9]{2,10}$'`),
    check('spaces_name_length', sql`char_length(${table.name}) between 1 and 100`),
    check('spaces_description_length', sql`char_length(${table.description}) <= 2000`),
    check('spaces_icon_length', sql`${table.icon} is null or char_length(${table.icon}) <= 16`),
  ],
);

/**
 * Wiki pages.
 *
 * The tree is stored twice on purpose: `parent_id` is the edge a move has to
 * update, and `path` is the materialised path (`/backend/auth`) that makes a
 * subtree query a single prefix scan instead of a recursive walk. The two are
 * kept in step inside one transaction — a move rewrites the descendants' paths
 * with the parent's.
 *
 * Deletion is a soft delete: `deleted_at` is set and the row stays, so its
 * revision history survives. The uniqueness of `path` is therefore scoped to
 * live rows, which is what lets a path be reused after its page is deleted —
 * and to the page's space, so the same path can exist once per space.
 */
export const pages = pgTable(
  'pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The space the page lives in. A page never changes space. */
    spaceId: uuid('space_id')
      .notNull()
      .references((): AnyPgColumn => spaces.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => pages.id, {
      onDelete: 'set null',
    }),
    /** Materialised path, always absolute and lowercase: `/backend/auth`. */
    path: text('path').notNull(),
    title: text('title').notNull(),
    kind: pageKind('kind').notNull().default('technical'),
    /** The counterpart of the technical/human pair, when one exists. */
    linkedPageId: uuid('linked_page_id').references((): AnyPgColumn => pages.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull().default(''),
    summary: text('summary'),
    /** SHA-256 of `body`. Callers echo it back to detect a lost update. */
    contentHash: text('content_hash').notNull(),
    /** Bumped on every write; matches the newest `page_revisions.version`. */
    version: integer('version').notNull().default(1),
    /**
     * Maintained by PostgreSQL, not by the application, so a row written by
     * any path — handler, migration, psql — is searchable. The weights rank a
     * title hit above a summary hit above a body hit.
     */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce("title", '')), 'A') || setweight(to_tsvector('english', coalesce("summary", '')), 'B') || setweight(to_tsvector('english', coalesce("body", '')), 'C')`,
    ),
    createdByType: actorType('created_by_type').notNull(),
    createdById: text('created_by_id').notNull(),
    updatedByType: actorType('updated_by_type').notNull(),
    updatedById: text('updated_by_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('pages_space_path_key')
      .on(table.spaceId, table.path)
      .where(isNull(table.deletedAt)),
    index('pages_space_parent_idx').on(table.spaceId, table.parentId),
    index('pages_space_path_idx').on(table.spaceId, table.path),
    index('pages_workspace_updated_idx').on(table.workspaceId, table.updatedAt),
    index('pages_search_idx').using('gin', table.searchVector),
  ],
);

/**
 * Append-only history. One row per write, including the first, so version 1 of
 * a page is recoverable from the same table as every later one.
 */
export const pageRevisions = pgTable(
  'page_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    summary: text('summary'),
    contentHash: text('content_hash').notNull(),
    authorType: actorType('author_type').notNull(),
    authorId: text('author_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('page_revisions_page_version_key').on(table.pageId, table.version),
    index('page_revisions_page_created_idx').on(table.pageId, table.createdAt),
    // The change feed of a space reads revisions newest first across pages.
    index('page_revisions_created_idx').on(table.createdAt, table.id),
  ],
);

/**
 * Claims: time-boxed leases on a page, or on a named section of one.
 *
 * A claim is the product's conflict-safe write primitive, so it is a row in
 * PostgreSQL rather than anything held in the application process: the row is
 * what two concurrent writers contend for, and it survives a restart the way an
 * in-memory lock does not.
 *
 * Two partial unique indexes are the safety net under the check the service
 * performs while holding a row lock on the page: at most one active page-level
 * claim per page, and at most one active claim per (page, section). The rule
 * they cannot express — a page-level claim excludes every section claim on that
 * page and the other way round — is enforced inside the same transaction, under
 * `select … for update` on the page row, which is what serialises the
 * check-then-insert. The indexes still catch anything that reaches the insert
 * by another path.
 *
 * "Active" means `released_at is null`. A claim past its TTL is released with
 * reason `expired` rather than merely ignored, so the indexes above describe
 * the same set of rows the service treats as live.
 */
export const claims = pgTable(
  'claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /** A named section of the page, or null for the whole page. */
    sectionId: text('section_id'),
    holderType: actorType('holder_type').notNull(),
    holderId: text('holder_id').notNull(),
    /**
     * The holder's display name as it stood when the claim was taken. Presence
     * has to name a holder even after the account is renamed or the token is
     * revoked, and neither id resolves to a name once that happens.
     */
    holderLabel: text('holder_label').notNull(),
    /** The page's content hash when the lease was granted. */
    baseContentHash: text('base_content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    /** Who ended it: the holder, the sweep (`system`), or an administrator. */
    releasedBy: text('released_by'),
    releaseReason: claimReleaseReason('release_reason'),
  },
  (table) => [
    uniqueIndex('claims_active_page_key')
      .on(table.pageId)
      .where(sql`${table.releasedAt} is null and ${table.sectionId} is null`),
    uniqueIndex('claims_active_section_key')
      .on(table.pageId, table.sectionId)
      .where(sql`${table.releasedAt} is null and ${table.sectionId} is not null`),
    index('claims_workspace_active_idx')
      .on(table.workspaceId, table.expiresAt)
      .where(isNull(table.releasedAt)),
    index('claims_holder_idx').on(table.holderType, table.holderId),
  ],
);

/**
 * Short-lived notes bound to a claim: "rewriting the auth section, leave
 * Overview alone".
 *
 * They are deliberately not revisions. A note is intent while an edit is in
 * flight, not a version of the document, so it never reaches `page_revisions`
 * and it is deleted when the claim it hangs on ends — by release, by expiry or
 * by an administrator.
 */
export const claimNotes = pgTable(
  'claim_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    authorType: actorType('author_type').notNull(),
    authorId: text('author_id').notNull(),
    authorLabel: text('author_label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Mirrors the claim's expiry, so a stale note is invisible even unswept. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('claim_notes_claim_idx').on(table.claimId),
    index('claim_notes_workspace_expires_idx').on(table.workspaceId, table.expiresAt),
    check('claim_notes_text_length', sql`char_length(${table.text}) <= 2000`),
  ],
);

/**
 * Anchors: the tie between a documentation section and a declaration in the
 * workspace's source repository.
 *
 * The identity of an anchor is `{kind, qualified_name}`, not a location.
 * `file_hint` is where the resolver looks first and nothing more — a
 * declaration moved to another file is the same anchor, found by a
 * repository-wide search for the same identity, and reported as
 * `moved-renamed` rather than as a change to the documentation.
 *
 * `token_hash` is a hash of the parser's token sequence for the declaration,
 * never of its text: a formatter run rewrites text hashes wholesale while
 * changing nothing a reader cares about. For a `fallback` anchor — a block
 * with no resolvable declaration, such as a configuration stanza — the same
 * column holds the hash of the normalised line range instead, and
 * `line_start`/`line_end` are the anchor rather than display metadata.
 *
 * Nothing here is ever rewritten automatically. A state other than `fresh` is
 * shown to a human or an agent, who reviews it and confirms.
 */
export const anchors = pgTable(
  'anchors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    /** The section of the page this anchor belongs to, or null for the page. */
    sectionId: text('section_id'),
    /**
     * Grammar the declaration was read with. Plain text rather than an enum:
     * supporting one more language is a table in `@clewwiki/anchors`, and it
     * must not also be a migration.
     */
    language: text('language').notNull(),
    /** Declaration kind as the grammar names it: `func`, `class`, `method`. */
    kind: text('kind').notNull(),
    qualifiedName: text('qualified_name').notNull(),
    /** Enclosing declaration, used by the rename stage of the resolver. */
    container: text('container'),
    /** Repository-relative path where the declaration was last seen. */
    fileHint: text('file_hint').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Hash of the body tokens alone; what survives a rename. */
    bodyHash: text('body_hash'),
    bodyTokenCount: integer('body_token_count').notNull().default(0),
    lineStart: integer('line_start'),
    lineEnd: integer('line_end'),
    /** True when this anchor is a line range rather than a declaration. */
    fallback: boolean('fallback').notNull().default(false),
    state: anchorState('state').notNull().default('fresh'),
    /** What the last check found: the file it resolved to, a new name, a diff. */
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    /** The ref the last check ran against, and when. */
    lastCheckedRef: text('last_checked_ref'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdByType: actorType('created_by_type').notNull(),
    createdById: text('created_by_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('anchors_page_idx').on(table.pageId),
    index('anchors_workspace_state_idx').on(table.workspaceId, table.state),
    index('anchors_workspace_file_idx').on(table.workspaceId, table.fileHint),
    // One anchor per target per section: re-anchoring the same declaration on
    // the same section is an update, not a second row to check twice.
    // Two partial indexes rather than one over a nullable column: in
    // PostgreSQL every null is distinct from every other, so a single index
    // including `section_id` would happily accept the same page-level target
    // twice. Same shape as the claims indexes, for the same reason.
    uniqueIndex('anchors_page_target_key')
      .on(table.pageId, table.kind, table.qualifiedName, table.fileHint)
      .where(isNull(table.sectionId)),
    uniqueIndex('anchors_section_target_key')
      .on(table.pageId, table.sectionId, table.kind, table.qualifiedName, table.fileHint)
      .where(sql`${table.sectionId} is not null`),
  ],
);

/**
 * Skills: reusable instruction packages an agent installs on its own machine.
 *
 * A skill is the `SKILL.md` convention — front matter naming the skill and
 * saying when to use it, then a Markdown body — stored as columns plus a body
 * rather than as one blob, so that listing a space's skills, filtering them by
 * tag and showing a name never means parsing YAML out of text.
 *
 * Its own table rather than a kind of page, because a skill is not part of the
 * page tree: it has no path, no parent, no technical/human counterpart and no
 * claim, and it is addressed by a slug that has to be safe as a directory name
 * on the machine that installs it. What it shares with pages — soft deletion,
 * authorship on both ends, an audit row per change — it shares by shape.
 *
 * `slug` is unique per space among live rows, the same way a page path is, so a
 * deleted skill's slug can be taken again.
 */
export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references((): AnyPgColumn => spaces.id, { onDelete: 'cascade' }),
    /** Lowercase words joined by hyphens; also the directory the CLI writes. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** One line: what the skill does and when an agent should reach for it. */
    description: text('description').notNull(),
    /** The Markdown body, without front matter — that is rebuilt from the columns. */
    body: text('body').notNull().default(''),
    /** Free text, semver-shaped by convention and not by constraint. */
    version: text('version'),
    tags: text('tags').array().notNull().default([]),
    createdByType: actorType('created_by_type').notNull(),
    createdById: text('created_by_id').notNull(),
    updatedByType: actorType('updated_by_type').notNull(),
    updatedById: text('updated_by_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('skills_space_slug_key')
      .on(table.spaceId, table.slug)
      .where(isNull(table.deletedAt)),
    index('skills_space_updated_idx').on(table.spaceId, table.updatedAt),
    index('skills_workspace_idx').on(table.workspaceId),
    check('skills_slug_format', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('skills_slug_length', sql`char_length(${table.slug}) <= 80`),
    check('skills_name_length', sql`char_length(${table.name}) between 1 and 100`),
    check('skills_description_length', sql`char_length(${table.description}) between 1 and 1024`),
    check('skills_version_length', sql`${table.version} is null or char_length(${table.version}) <= 40`),
    // Octets, not characters: the limit exists to bound what a response and a
    // written file carry, and a body of Cyrillic is twice its character count.
    check('skills_body_size', sql`octet_length(${table.body}) <= 262144`),
  ],
);

/**
 * Imports: a batch of documentation brought in from somewhere else.
 *
 * The table exists because an import is staged rather than applied. Parsing a
 * Confluence space or a PDF produces a guess about structure, and a guess must
 * not silently become somebody's wiki — so the parsed result lands in
 * `import_items`, a person reads it, edits the target paths, unticks what they
 * do not want, and only then does anything reach `pages`. That review step is
 * the product decision this schema encodes.
 *
 * `params` records what the import was pointed at and never how it got in. A
 * Confluence import stores the site address and the space key; the e-mail and
 * API token it used exist in memory for the length of one request and are
 * written nowhere — not here, not in the audit log, not in an error message.
 *
 * An import is deleted with its items once it has been applied and nobody needs
 * the record any more; the pages it created are ordinary pages and stay.
 */
export const imports = pgTable(
  'imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The space the pages will be created in. An import never spans spaces. */
    spaceId: uuid('space_id')
      .notNull()
      .references((): AnyPgColumn => spaces.id, { onDelete: 'cascade' }),
    source: importSource('source').notNull(),
    status: importStatus('status').notNull().default('pending'),
    /**
     * The person who started it. Agent tokens cannot import — an import is a
     * bulk, irreversible-by-default write of somebody else's documents, and it
     * is reviewed by a human before it happens — so this is always a user.
     */
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** What the import was pointed at. Never a credential. */
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    /** Counts filled in as the import progresses: parsed, created, skipped. */
    stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
    /** Why it failed, in the words the caller was given. */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('imports_space_created_idx').on(table.spaceId, table.createdAt),
    index('imports_workspace_status_idx').on(table.workspaceId, table.status),
  ],
);

/**
 * One page-to-be of an import.
 *
 * `source_id` is the identity the source itself used — a Confluence page id, a
 * path inside a ZIP — and `parent_source_id` refers to it, so the tree survives
 * re-ordering and a reviewer moving a page. `markdown` holds the converted body
 * with its intra-import links still as placeholders; they are resolved when the
 * preview is rendered and again when the import is applied, which is what keeps
 * a link correct after a target path is edited.
 *
 * `decision` is the reviewer's: `create` by default, `skip` for anything they
 * do not want, `overwrite` for a path that already has a page and should be
 * replaced. `created_page_id` is filled in when the item is applied, so an
 * import that is applied twice does not create the same page twice.
 */
export const importItems = pgTable(
  'import_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importId: uuid('import_id')
      .notNull()
      .references((): AnyPgColumn => imports.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    title: text('title').notNull(),
    /** Absolute, normalised, unique within the import. A reviewer may change it. */
    targetPath: text('target_path').notNull(),
    parentSourceId: text('parent_source_id'),
    markdown: text('markdown').notNull().default(''),
    /** What the converter could not carry across, as `{code, detail}` objects. */
    warnings: jsonb('warnings').$type<Array<Record<string, unknown>>>().notNull().default([]),
    decision: importDecision('decision').notNull().default('create'),
    createdPageId: uuid('created_page_id').references((): AnyPgColumn => pages.id, {
      onDelete: 'set null',
    }),
    ordering: integer('ordering').notNull().default(0),
  },
  (table) => [
    uniqueIndex('import_items_import_source_key').on(table.importId, table.sourceId),
    index('import_items_import_ordering_idx').on(table.importId, table.ordering),
  ],
);

/**
 * The images an import brought with it, held until it is applied.
 *
 * An image belongs to a page, and between staging and applying there is no
 * page — so the bytes wait here, keyed by the path the archive had them under,
 * which is what the `clewwiki-import-image:` placeholders in `markdown` name.
 * Applying copies each one into `page_images` for every page that shows it and
 * empties this table for the import; cancelling empties it too, and deleting
 * the import takes whatever is left. They were validated when they were staged
 * — type from the bytes, size, room in the store — so what is here is what
 * `page_images` will take.
 */
export const importImages = pgTable(
  'import_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importId: uuid('import_id')
      .notNull()
      .references((): AnyPgColumn => imports.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    data: bytea('data').notNull(),
  },
  (table) => [
    uniqueIndex('import_images_import_key').on(table.importId, table.key),
    check('import_images_size', sql`octet_length(${table.data}) <= 10485760`),
  ],
);

/**
 * Discussions: where agents and people working in parallel talk to each other
 * about work that crosses more than one of their areas.
 *
 * The table exists because that conversation has to happen somewhere and must
 * not stay. "I am changing the auth contract, does anything of yours depend on
 * it?" is worth saying and worth answering; six months later it is clutter that
 * a reader has to wade through to find out what was actually decided. So the
 * thread is ephemeral — closed when it goes quiet, deleted a week after it is
 * resolved — and the outcome is promoted to a **decision page**, which is an
 * ordinary page of the space: versioned, searchable, exportable, linkable.
 *
 * `expires_at` is the one column the sweep reads. While a discussion is open it
 * holds "when this will be closed for inactivity" (last activity plus the
 * space's idle window); once it is resolved it holds "when this will be
 * deleted" (resolution plus the space's retention window). One deadline, one
 * index, and the UI can always say when a thread goes away.
 *
 * `decision_page_id` points at the page the resolution produced. Deleting the
 * discussion never touches it: the reference goes the other way, so the page
 * outlives the conversation that produced it, which is the entire point.
 */
export const discussions = pgTable(
  'discussions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references((): AnyPgColumn => spaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: discussionStatus('status').notNull().default('open'),
    openedByType: actorType('opened_by_type').notNull(),
    openedById: text('opened_by_id').notNull(),
    /**
     * The opener's display name as it stood when the thread was opened, for the
     * same reason a claim snapshots its holder: the thread has to name who
     * started it after the account is renamed or the token revoked.
     */
    openedByLabel: text('opened_by_label').notNull(),
    /** The page the discussion is about, when it is about one. */
    pageId: uuid('page_id').references((): AnyPgColumn => pages.id, { onDelete: 'set null' }),
    /** A named section of that page, or null for the whole page. */
    sectionId: text('section_id'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** Who resolved it: an actor id, or `system` when the sweep closed it. */
    resolvedBy: text('resolved_by'),
    /** The page the decision was written to. Never deleted with the thread. */
    decisionPageId: uuid('decision_page_id').references((): AnyPgColumn => pages.id, {
      onDelete: 'set null',
    }),
    /** When this thread is next acted on: closed while open, deleted once resolved. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('discussions_space_status_idx').on(table.spaceId, table.status, table.lastActivityAt),
    index('discussions_space_activity_idx').on(table.spaceId, table.lastActivityAt),
    index('discussions_workspace_expires_idx').on(table.workspaceId, table.expiresAt),
    index('discussions_page_idx').on(table.pageId),
    check('discussions_title_length', sql`char_length(${table.title}) between 1 and 200`),
  ],
);

/**
 * One message in a discussion.
 *
 * Markdown, capped at 8 KB of octets rather than characters — the limit exists
 * to bound what a thread costs to read back, and a message of Cyrillic is twice
 * its character count. Deleted with its discussion; there is no soft delete,
 * because a thread that is gone is gone.
 *
 * Message bodies are text other people and other agents wrote. Every path that
 * hands them to an agent says so.
 */
export const discussionMessages = pgTable(
  'discussion_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    discussionId: uuid('discussion_id')
      .notNull()
      .references((): AnyPgColumn => discussions.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    authorType: actorType('author_type').notNull(),
    authorId: text('author_id').notNull(),
    authorLabel: text('author_label').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('discussion_messages_discussion_idx').on(table.discussionId, table.createdAt),
    index('discussion_messages_workspace_idx').on(table.workspaceId),
    check('discussion_messages_body_size', sql`octet_length(${table.body}) between 1 and 8192`),
  ],
);

/**
 * Page reviews: one row per act of a person looking at what agents changed on a
 * page and deciding about it.
 *
 * Agents write without asking — that is what makes them useful — so the review
 * comes after the write, not before it. A row covers a *range* of versions
 * rather than one revision, because that is how the work is actually read: an
 * agent that touched a page four times in an afternoon produced one change as
 * far as the reader is concerned, and what they compare is the page as they
 * last knew it (`from_version`, exclusive) with the page as it stands
 * (`to_version`, inclusive).
 *
 * What still needs a look is derived, never stored: the newest version that a
 * person wrote or accepted is the baseline, and agent revisions after it are
 * pending. A person editing the page therefore settles everything before their
 * edit without a row here, and a `reverted` row is followed by the revision the
 * revert wrote (`result_version`), which is a person's and so a baseline too.
 *
 * `from_version` is 0 when the page has no baseline at all — an agent created
 * it and nobody has looked since. Such a page can be accepted and cannot be
 * reverted: there is nothing to put it back to, and removing it is a delete.
 */
export const pageReviews = pgTable(
  'page_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references((): AnyPgColumn => spaces.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id')
      .notNull()
      .references((): AnyPgColumn => pages.id, { onDelete: 'cascade' }),
    decision: reviewDecision('decision').notNull(),
    /** The baseline the reviewer compared against; exclusive, 0 for none. */
    fromVersion: integer('from_version').notNull(),
    /** The newest version the reviewer saw; inclusive. */
    toVersion: integer('to_version').notNull(),
    /** The version the revert wrote. Null for `accepted`. */
    resultVersion: integer('result_version'),
    /** Always a person: an agent token cannot review. */
    reviewerId: text('reviewer_id').notNull(),
    /** The reviewer's name as it stood, for the same reason a claim snapshots its holder. */
    reviewerLabel: text('reviewer_label').notNull(),
    /** Why, in the reviewer's words. What an agent reads to learn what was wrong. */
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('page_reviews_page_idx').on(table.pageId, table.toVersion),
    index('page_reviews_space_created_idx').on(table.spaceId, table.createdAt),
    check(
      'page_reviews_version_range',
      sql`${table.fromVersion} >= 0 and ${table.toVersion} > ${table.fromVersion}`,
    ),
    check(
      'page_reviews_note_length',
      sql`${table.note} is null or char_length(${table.note}) between 1 and 2000`,
    ),
  ],
);

/**
 * Comments on a page, each thread attached to one paragraph of it or to the
 * page as a whole.
 *
 * A review note says why a change was reverted; a comment says *where* the
 * problem is. A thread is a root row and its replies (`parent_id`), one level
 * deep — a comment is a remark about a paragraph, not a forum.
 *
 * The anchor lives on the root: `block_fingerprint` is a fingerprint of the
 * paragraph's text, `block_index` where it was and `version` the version the
 * commenter was reading. A comment follows its paragraph through edits
 * elsewhere on the page and is reported as outdated once the paragraph itself
 * is rewritten — never moved to whatever took its place. `quote` keeps an
 * excerpt so an outdated comment can still show what it was about. All four are
 * null for a comment on the page as a whole.
 *
 * Unlike discussions, comments stay: a resolved thread is the record of what a
 * reviewer asked for and what was done about it. They go when the page goes.
 * Bodies are text other people and other agents wrote, and every path that
 * hands them to an agent says so.
 */
export const pageComments = pgTable(
  'page_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references((): AnyPgColumn => spaces.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id')
      .notNull()
      .references((): AnyPgColumn => pages.id, { onDelete: 'cascade' }),
    /** Null for the comment that opens a thread; the root's id for a reply. */
    parentId: uuid('parent_id').references((): AnyPgColumn => pageComments.id, {
      onDelete: 'cascade',
    }),
    /** The version the commenter was reading. Root only. */
    version: integer('version'),
    blockFingerprint: text('block_fingerprint'),
    blockIndex: integer('block_index'),
    quote: text('quote'),
    authorType: actorType('author_type').notNull(),
    authorId: text('author_id').notNull(),
    authorLabel: text('author_label').notNull(),
    body: text('body').notNull(),
    /** Root only. A resolved thread takes no more replies until it is reopened. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByType: actorType('resolved_by_type'),
    resolvedById: text('resolved_by_id'),
    resolvedByLabel: text('resolved_by_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('page_comments_page_idx').on(table.pageId, table.createdAt),
    index('page_comments_parent_idx').on(table.parentId, table.createdAt),
    // The open threads of a space: what is still waiting for somebody.
    index('page_comments_space_open_idx')
      .on(table.spaceId, table.createdAt)
      .where(sql`${table.parentId} is null and ${table.resolvedAt} is null`),
    check('page_comments_body_size', sql`octet_length(${table.body}) between 1 and 8192`),
    check(
      'page_comments_anchor_shape',
      sql`(${table.blockFingerprint} is null and ${table.blockIndex} is null and ${table.quote} is null)
        or (${table.parentId} is null and ${table.blockFingerprint} is not null and ${table.blockIndex} is not null and ${table.blockIndex} >= 0 and ${table.quote} is not null and ${table.version} is not null)`,
    ),
    check(
      'page_comments_reply_shape',
      sql`${table.parentId} is null or (${table.resolvedAt} is null and ${table.version} is null)`,
    ),
  ],
);

/**
 * The unsaved state of a live editing session, one row per page.
 *
 * People editing a page together share a CRDT document that lives in the
 * application's memory. This row is what survives when that memory does not —
 * a restart, a deploy — and what is left when the last person closes the tab
 * without saving: the next person to open the editor finds the text as it was
 * left rather than as it was last saved.
 *
 * `base_content_hash` is the version of the page the session was editing. The
 * state is only ever resumed against that exact version: if the page has been
 * written since — an agent took it once the session's claim lapsed — the row
 * describes edits to a text that no longer exists, and it is discarded rather
 * than merged. A row is deleted when the session saves with nobody left in it,
 * and goes with its page.
 *
 * The state is an encoded Yjs update: opaque bytes produced by browsers. It is
 * never parsed into a page by the server, never handed to an agent, and bounded
 * in size before it is stored.
 */
export const pageCollabStates = pgTable(
  'page_collab_states',
  {
    pageId: uuid('page_id')
      .primaryKey()
      .references((): AnyPgColumn => pages.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    baseVersion: integer('base_version').notNull(),
    baseContentHash: text('base_content_hash').notNull(),
    state: bytea('state').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('page_collab_states_workspace_idx').on(table.workspaceId),
    check('page_collab_states_size', sql`octet_length(${table.state}) <= 33554432`),
  ],
);

/**
 * Images uploaded into pages.
 *
 * Bytes live in the database, next to the pages that show them: one backup
 * restores a wiki whole, the container keeps its read-only filesystem, and an
 * image can only ever be read through a handler that has checked who is asking.
 * The price is paid in size, so an image is bounded here as well as in the
 * handler, and only raster formats a browser decodes without running anything
 * are accepted — the type stored is the one detected from the bytes, never the
 * one the client claimed, and it is the only type the image is served as.
 *
 * An image belongs to a page and is visible to whoever can see that page, in
 * whichever space the page is now. `page_id` is null only between an upload
 * from the new-page form and the save that creates the page; until then the
 * image is visible inside `space_id`, and one never claimed by a page is swept.
 * `space_id` is where it was uploaded and stops mattering once it is attached.
 */
export const pageImages = pgTable(
  'page_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references((): AnyPgColumn => spaces.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id').references((): AnyPgColumn => pages.id, { onDelete: 'cascade' }),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    data: bytea('data').notNull(),
    createdByType: actorType('created_by_type').notNull(),
    createdById: text('created_by_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('page_images_page_idx').on(table.pageId, table.sha256),
    index('page_images_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('page_images_unattached_idx').on(table.createdAt).where(sql`${table.pageId} is null`),
    check('page_images_size', sql`octet_length(${table.data}) <= 10485760`),
    check(
      'page_images_type',
      sql`${table.contentType} in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')`,
    ),
  ],
);

/**
 * How far each person and each agent has read their inbox.
 *
 * The inbox itself is not stored. What somebody should hear about — an answer
 * in a discussion they took part in, a reply under their comment, a comment on
 * or a review of what they wrote — is already in the tables those things live
 * in, and is read from there when the inbox is opened, under the visibility the
 * caller has at that moment. A stored notification would outlive the discussion
 * it came from and the membership that made it visible. So the only thing kept
 * is this: one timestamp per actor, everything after it is unread.
 */
export const inboxMarks = pgTable(
  'inbox_marks',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorType: actorType('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.actorType, table.actorId] })],
);

/**
 * Who may see a restricted space.
 *
 * Membership is about visibility and nothing more: a member of a restricted
 * space can do there what their workspace role lets them do anywhere else. The
 * rows mean nothing while the space is not restricted, and are kept when the
 * restriction is lifted, so switching it back on does not mean listing everyone
 * again. Workspace administrators need no row: they see every space, because
 * they can issue a token that does.
 */
export const spaceMembers = pgTable(
  'space_members',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references((): AnyPgColumn => spaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    addedBy: text('added_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.userId] }),
    index('space_members_user_idx').on(table.userId, table.workspaceId),
  ],
);

export type PageImage = typeof pageImages.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Space = typeof spaces.$inferSelect;
export type NewSpace = typeof spaces.$inferInsert;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type MembershipRole = (typeof membershipRole.enumValues)[number];
export type AgentToken = typeof agentTokens.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
export type PageKind = (typeof pageKind.enumValues)[number];
export type PageRevision = typeof pageRevisions.$inferSelect;
export type ActorKind = (typeof actorType.enumValues)[number];
export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;
export type ClaimReleaseReason = (typeof claimReleaseReason.enumValues)[number];
export type ClaimNote = typeof claimNotes.$inferSelect;
export type Anchor = typeof anchors.$inferSelect;
export type NewAnchor = typeof anchors.$inferInsert;
export type AnchorStateValue = (typeof anchorState.enumValues)[number];
export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
export type ImportRow = typeof imports.$inferSelect;
export type NewImportRow = typeof imports.$inferInsert;
export type ImportItemRow = typeof importItems.$inferSelect;
export type NewImportItemRow = typeof importItems.$inferInsert;
export type ImportSourceValue = (typeof importSource.enumValues)[number];
export type ImportStatusValue = (typeof importStatus.enumValues)[number];
export type ImportDecisionValue = (typeof importDecision.enumValues)[number];
export type DiscussionRow = typeof discussions.$inferSelect;
export type NewDiscussionRow = typeof discussions.$inferInsert;
export type DiscussionMessageRow = typeof discussionMessages.$inferSelect;
export type NewDiscussionMessageRow = typeof discussionMessages.$inferInsert;
export type DiscussionStatusValue = (typeof discussionStatus.enumValues)[number];
export type PageReviewRow = typeof pageReviews.$inferSelect;
export type NewPageReviewRow = typeof pageReviews.$inferInsert;
export type ReviewDecisionValue = (typeof reviewDecision.enumValues)[number];
export type PageCommentRow = typeof pageComments.$inferSelect;
export type NewPageCommentRow = typeof pageComments.$inferInsert;
export type PageCollabStateRow = typeof pageCollabStates.$inferSelect;
export type SpaceMemberRow = typeof spaceMembers.$inferSelect;
