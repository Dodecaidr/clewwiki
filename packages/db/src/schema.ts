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
 */
export interface WorkspaceSettings {
  /**
   * Default lease length for a claim, in seconds. Absent means the server
   * default (10 minutes); a caller may still ask for a shorter or longer TTL
   * within the bounds the claim service enforces.
   */
  claim_ttl_seconds?: number;
  /** The source repository this workspace's anchors are checked against. */
  repository?: WorkspaceRepositorySettings;
}

/**
 * Where the code an anchor points at lives.
 *
 * `auth_token_env` names an environment variable, never a token: a credential
 * written into a settings row would be readable by anything that can read the
 * workspace, would survive in database backups, and would have to be redacted
 * from every API response that carries settings. The operator sets the variable
 * on the process; the application only ever learns its name.
 */
export interface WorkspaceRepositorySettings {
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
 * live rows, which is what lets a path be reused after its page is deleted.
 */
export const pages = pgTable(
  'pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
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
    uniqueIndex('pages_workspace_path_key')
      .on(table.workspaceId, table.path)
      .where(isNull(table.deletedAt)),
    index('pages_workspace_parent_idx').on(table.workspaceId, table.parentId),
    index('pages_workspace_path_idx').on(table.workspaceId, table.path),
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

export type Workspace = typeof workspaces.$inferSelect;
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
