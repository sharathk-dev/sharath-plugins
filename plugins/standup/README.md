# standup

A Claude Code plugin with one slash command: `/standup` shows what you did recently as one card in the chat: GitHub commits, PRs you merged, opened or reviewed, and Jira tickets you moved. A button puts a draft of your standup update in the prompt box. For the live view of your open PRs, see [pr-status](../pr-status/README.md).

## /standup

| Command | Window |
|---|---|
| `/standup` | Yesterday plus today so far. On Mondays, from Friday. |
| `/standup yesterday` | Yesterday only. |
| `/standup today` | Today so far. |
| `/standup 3d` | The last N days (`Nd`, any number from 1), from midnight N days ago until now. |

The card has up to three sections:

| Section | Shows |
|---|---|
| Commits | Commit count per repo (the ten with most activity), with the latest commit headlines for the five most recent. |
| PRs | PRs you merged, opened or reviewed in the window, each clickable. A PR you opened and merged is listed once, as merged. |
| Jira | Tickets whose status you changed in the window, with the status they moved to, coloured by status category. |

Draft update puts text like this in the prompt box, for you to edit before sending:

```text
Yesterday:
- 3 commits in web (Add modulo; Fix divide)
- Merged web#2 Add modulo
- KAN-3 Login page -> In Review

Today: continue KAN-3 Login page
Blockers: none
```

## How it works

- GitHub: two `gh api graphql` calls. The first reads your contributions (commits per repo, PRs opened and reviewed) and searches for your merged PRs. The second, only when you committed, reads commit headlines from the default branch of up to five repos.
- Jira: one JQL search, `status CHANGED BY currentUser() DURING (...)`, with a 4 s timeout.
- Both run in parallel. The result is also kept as text in the transcript, so Claude can see it.

## Jira status (optional)

Jira is not required. With a Jira MCP server connected, the Jira section appears. With none, or if Jira doesn't answer, the section is hidden and the header says "Jira unavailable". The GitHub part still shows.

The server is detected from the tools it offers, with no configuration, the same way as in [pr-status](../pr-status/README.md#jira-status-optional):

- the official Atlassian plugin (`searchJiraIssuesUsingJql`)
- `mcp-atlassian` (`jira_search`)
- any MCP tool whose name looks like a Jira search and takes `{jql}`

## Only some repos (optional)

By default /standup shows every repo your `gh` login can see. To keep it to some GitHub owners, for example only your company's orgs on a work laptop, set **Only these GitHub owners** (`owners`) in the `/plugin` config menu: orgs or users, comma separated (`my-company, my-team-org`). Case doesn't matter. The value is kept in your Claude Code settings on that machine, so plugin updates leave it in place.

## Requirements

| Need | For |
|---|---|
| A recent Claude Code with mods (function-hook plugins) | `/standup` |
| `gh`, logged in | commits and PRs |
| A Jira MCP server, connected | the Jira section (optional) |

## Privacy

Read-only. It only reads from GitHub and Jira. Opening a link runs `xdg-open` (or `open` on macOS).

## Development

```bash
claude plugin test plugins/standup
claude plugin validate plugins/standup
```

## Limits

- Commit counts come from GitHub's contribution data, so they cover the ten repos with the most activity and commits GitHub counts as yours.
- Commit headlines are read from the default branch of the five most recent repos, up to five each.
