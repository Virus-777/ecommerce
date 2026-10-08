/**
 * What the content service needs from the outside world, database-agnostic.
 * The Postgres adapter lives in infra/postgres/; a MongoDB switch would add infra/mongo/.
 */

/** Persistence for this module's own tables: content.home_sections, content.pages, content.versions, content.help_categories, content.help_articles, content.article_feedback, content.policies, content.policy_versions, content.policy_approvals, content.navigation, content.content_log. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ContentRepository {}
