# jira-tasks

A Claude Code plugin with one slash command: `/jira` shows your open Jira issues as a card in the chat, with their open GitHub PRs. For a board of all your PRs, see the companion plugin [pr-status](../pr-status/README.md).

## /jira

Issues assigned to you that aren't done (`assignee = currentUser() AND statusCategory != Done`, newest update first).

- Grouped by status, work under way first, then waiting work.
- Coloured by Jira's status category, so custom statuses work. Blocked and hold are red, review and QA are magenta.
- A chip per issue type: Story, Task, Epic, Bug, Subtask.
- Subtasks are nested under their parent when the parent is also listed. Otherwise the row names its parent.
- The key is a button that opens the issue in your browser.
- When the 50-issue limit cuts the list off, a dim `… more in Jira →` line at the bottom opens the full search in your browser.
- Long summaries end in "…".
- Your open PRs whose title mentions the key show as a clickable `PR#n` (`PR#n +1` for more than one).

## Requirements

| Need | For |
|---|---|
| A recent Claude Code with mods (function-hook plugins) | `/jira` |
| A Jira MCP server, connected | `/jira` |
| `gh`, logged in | the PR column |

The Jira server is detected from the tools it offers, with no configuration:

- the official Atlassian plugin (`searchJiraIssuesUsingJql`)
- `mcp-atlassian` (`jira_search`)
- any MCP tool whose name looks like a Jira search and takes `{jql}`

Without `gh`, `/jira` still works, just with no PR column.

## Privacy

Read-only. It only reads from Jira and GitHub. Opening a link runs `xdg-open` (or `open` on macOS).

## Development

```bash
claude plugin test plugins/jira-tasks
claude plugin validate plugins/jira-tasks
```

## Limits

- Matches a PR to an issue by the key in the PR title.
- Lists the first 50 issues, and looks at up to 100 of your open PRs.
