# How clewwiki compares

clewwiki is a young project next to tools that have had years. This page is for
deciding quickly whether it fits, which includes the cases where it does not.

Everything said about another product here was read from that product's own
pricing page, documentation or repository on 2026-09-20, and each claim links to
where it came from. Products change. If something here is out of date, open an
issue and it will be corrected.

## In one table

| | clewwiki | Confluence | Docmost | Outline | BookStack | Wiki.js |
|---|---|---|---|---|---|---|
| License | AGPL-3.0 | proprietary | AGPL-3.0, plus paid editions | BSL 1.1 | MIT | AGPL-3.0 |
| Self-hosted | yes | Data Center, ending in 2029 | yes | yes | yes | yes |
| Official MCP server | yes, in the one edition | yes, for Cloud sites | yes, in the paid editions | yes | no | no |
| Agents can write pages | yes | yes | see their docs | yes | through the REST API | through the GraphQL API |
| Page leases against lost updates | yes | no | no | no | no | no |
| Review queue for agent changes | yes | no | page verification, paid | no | no | no |
| Pages anchored to code | yes | no | no | no | no | no |
| Runs with only a database | yes, PostgreSQL | n/a | needs Redis as well | needs Redis as well | yes, MySQL or MariaDB | yes |
| Invite people without a mail server | yes | n/a | mail is configured by SMTP or Postmark | sign-in needs a third-party provider | yes | yes |
| Single sign-on | **no** | yes | paid editions | yes | yes | yes |
| Import from Confluence | Cloud, Server and Data Center | n/a | paid editions | yes | no built-in importer | no built-in importer |
| Years in production | under one | over twenty | three | ten | eleven | ten |

## Confluence

Atlassian ends Data Center on 28 March 2029: subscriptions expire and the
products become read-only. New customers have been unable to buy it since 30
March 2026
([Atlassian](https://www.atlassian.com/licensing/data-center-end-of-life)). The
official Atlassian MCP server is hosted by Atlassian and connects to Atlassian
Cloud ([repository](https://github.com/atlassian/atlassian-mcp-server)), so a
team that stays on its own server connects agents through community projects.

clewwiki imports a space from either: Cloud over the REST API v2, Server and
Data Center over v1. Choose clewwiki if the reason you ran Confluence yourself
still holds and you want agents on the same pages. Stay with Confluence, or move to its Cloud, if
you depend on Jira integration, the Marketplace, single sign-on, or macros that
have no Markdown equivalent: clewwiki imports a macro it cannot convert as a
visible note, not as working content. [Moving from Confluence](from-confluence.md)
has the details.

## Docmost

The closest neighbour: AGPL, self-hosted, a good editor, real-time
collaboration. The difference is what the free edition contains. On
[Docmost's pricing page](https://docmost.com/pricing), MCP, API keys, the
Confluence importer, page-level permissions and single sign-on are in Business,
at $6 per seat per month billed annually with a minimum of ten seats, and audit
logs are in Enterprise. Its
[`.env.example`](https://github.com/docmost/docmost/blob/main/.env.example)
configures Redis and a mail driver.

In clewwiki those are all in the one edition, and the stack is PostgreSQL alone.
Docmost is the better choice today if you need single sign-on, a company behind
the product, or a larger community. clewwiki is the better choice if agents are
the point and a per-seat licence is not something you want for them.

## Outline

The most polished editor of the group, and it has an
[official MCP server](https://docs.getoutline.com/s/guide/doc/mcp-6j9jtENNKL)
through which assistants search, read, create and edit documents, on
self-hosted installations too. Two things to know before hosting it. The
licence is the
[Business Source License 1.1](https://github.com/outline/outline/blob/main/LICENSE),
which is source-available, not open source. And its
[`.env.sample`](https://github.com/outline/outline/blob/main/.env.sample)
requires Redis and says that at least one third-party sign-in provider — Slack,
Google, Azure, Discord or OIDC — is needed for a working installation.

Choose Outline for the editor and for single sign-on. Choose clewwiki if you want
an OSI licence, password login with nothing to register elsewhere, or the parts
built around agents: leases, the review queue and code anchors.

## BookStack

Mature, MIT-licensed, simple to reason about, with a shelves-books-chapters
structure many teams like. It is a
[PHP application with MySQL or MariaDB](https://www.bookstackapp.com/docs/admin/installation/).
It has a REST API and no official MCP server; several community servers exist.
Choose BookStack if agents are not part of the picture. It has ten more years of
edge cases behind it than clewwiki does.

## Wiki.js

AGPL, many storage and authentication modules, Git synchronisation. The current
line is 2.5; the latest release at the time of writing is
[v2.5.314 of May 2026](https://github.com/requarks/wiki/releases). There is no
official MCP server. Choose Wiki.js if Git-backed storage or its authentication
modules are what you need.

## What only clewwiki does

These matter once an agent has write access, and nothing above has them:

- **Leases.** A writer, person or agent, claims a page before writing. A second
  writer gets a conflict naming the holder instead of overwriting.
- **Review after the fact.** Agent changes queue as diffs. A person accepts or
  reverts with a note the agent reads before trying again.
- **Anchors to code.** A page points at a declaration in your repository and is
  marked stale when the body of that declaration changes.
- **Rules and skills for every agent.** One place, read over MCP by whichever
  tool a teammate uses.

## When not to choose clewwiki

- You need single sign-on now.
- You are moving a large Confluence Data Center site and need an importer with a
  track record. The Data Center route is written against the v1 API and tested
  against fixtures taken from a live site, but it is new.
- You need a vendor to call. This is a one-maintainer project.
- Agents are not going to write to your wiki. The mature tools above are then
  the safer choice.
