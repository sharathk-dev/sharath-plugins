# pr-status

A Claude Code plugin with one slash command: `/pr` shows your open GitHub PRs and the ones waiting on your review as a card in the chat. For your Jira tasks, see the companion plugin [jira-tasks](../jira-tasks/README.md).

## /pr

Your open PRs ("Mine") and PRs waiting on your review ("Waiting on you"), fetched with one GitHub GraphQL call through `gh`. Each row shows:

| Part | Meaning |
|---|---|
| `PR#n` | Clickable, opens the PR. Drafts are dimmed. |
| repo, title | Review requests also show the author. |
| Jira key | Clickable once the Jira site is known (see below). |
| Jira status | Next to the key. Red when your open PR is on a Done issue. |
| `resolved/total` | Review threads on your PRs. `●n` is how many wait on you (unresolved, last comment is someone else's). |
| `⚠ conflict` | Your PR can't merge cleanly. |
| CI mark | `✓` passing, `✗` failing, `●` running. |
| `✗ name · name` | Names of the failing checks, on a line below. |
| Review state | Approved, Changes, Review or Draft. |

Stacked PRs (base is not the default branch) are nested under the PR they build on. If that PR isn't listed, the row names its base branch.

## Jira status (optional)

Jira is not required. With a Jira MCP server connected, the status of each PR's issue appears next to its key, from one lookup with a 4 s timeout. With none, or if Jira doesn't answer, the Jira column is hidden and the header says "Jira unavailable". The PR list still shows.

The Jira server is detected from the tools it offers, with no configuration:

- the official Atlassian plugin (`searchJiraIssuesUsingJql`)
- `mcp-atlassian` (`jira_search`)
- any MCP tool whose name looks like a Jira search and takes `{jql}`

The key links to the issue once the site is known: from the Atlassian plugin's site list, or from the URL of the issues the server returns, so any of the servers above works.

## Requirements

| Need | For |
|---|---|
| A recent Claude Code with mods (function-hook plugins) | `/pr` |
| `gh`, logged in | `/pr` |
| A Jira MCP server, connected | the Jira status (optional) |

## Privacy

Read-only. It only reads from GitHub and Jira. Opening a link runs `xdg-open` (or `open` on macOS).

## Development

```bash
claude plugin test plugins/pr-status
claude plugin validate plugins/pr-status
```

## Limits

- Matches a PR to an issue by the key in the title, then the branch name.
- Lists the first 50 PRs in each section.
