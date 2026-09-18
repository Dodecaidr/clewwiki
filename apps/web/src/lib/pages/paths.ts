/**
 * Page paths.
 *
 * The rules themselves live in `@clewwiki/content/paths`, because the import
 * pipeline in `@clewwiki/import` has to produce exactly the paths this
 * application would produce for the same titles. Two implementations of
 * "what segment does this title get" would drift the first time one of them
 * gained a transliteration rule, so there is one, in a package both sides
 * depend on. This module stays as the application's import site so that every
 * caller inside `apps/web` keeps reading `@/lib/pages/paths`.
 */

export * from '@clewwiki/content/paths';
