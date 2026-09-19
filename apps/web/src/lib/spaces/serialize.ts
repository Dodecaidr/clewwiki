import { readRepositorySettings } from '../repository/settings';
import type { SpaceRecord, SpaceSummary } from './service';

/**
 * Wire shape for spaces, in the snake_case of the rest of the API.
 *
 * The repository link is shown in full only to an administrator. It holds no
 * secret — the token is named by an environment variable, never stored — but
 * the URL of a private repository is still not something every agent token
 * needs to read; everyone else learns only whether one is linked.
 */
export interface SpaceResource {
  key: string;
  name: string;
  description: string;
  icon: string | null;
  home_page_id: string | null;
  /** The page holding the project's rules, or null. `GET …/rules` reads it. */
  rules_page_id: string | null;
  archived: boolean;
  /** True when only members and workspace administrators can see the space. */
  restricted: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  has_repository: boolean;
  repository?: { url: string; default_ref: string; auth_token_env: string | null } | null;
  page_count?: number;
  last_updated_at?: string | null;
}

export interface SerializeSpaceOptions {
  includeRepository?: boolean;
}

export function toSpaceResource(
  space: SpaceRecord | SpaceSummary,
  options: SerializeSpaceOptions = {},
): SpaceResource {
  const repository = readRepositorySettings(space.settings);
  const resource: SpaceResource = {
    key: space.key,
    name: space.name,
    description: space.description,
    icon: space.icon,
    home_page_id: space.homePageId,
    rules_page_id: space.rulesPageId,
    archived: space.archivedAt !== null,
    restricted: space.restricted,
    archived_at: space.archivedAt?.toISOString() ?? null,
    created_at: space.createdAt.toISOString(),
    updated_at: space.updatedAt.toISOString(),
    has_repository: repository !== null,
  };
  if (options.includeRepository) {
    resource.repository = repository
      ? {
          url: repository.url,
          default_ref: repository.default_ref,
          auth_token_env: repository.auth_token_env ?? null,
        }
      : null;
  }
  if ('pageCount' in space) {
    resource.page_count = space.pageCount;
    resource.last_updated_at = space.lastUpdatedAt?.toISOString() ?? null;
  }
  return resource;
}
