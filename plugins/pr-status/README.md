# pr-status

A Claude Code plugin with one slash command: `/pr` shows your open GitHub PRs and the ones waiting on your review as a card in the chat. For your Jira tasks, see the companion plugin [jira-tasks](../jira-tasks/README.md).

## /pr

Your open PRs and PRs waiting on your review, fetched with one GitHub GraphQL call through `gh`. The card groups your PRs by what they need:

- **Needs you**: a reply waiting on you, a merge conflict, failing CI, or an open PR whose Jira ticket is done.
- **Waiting on others**: in review, nothing for you to do.
- **Drafts**: your drafts, problems or not.
- **Review requests**: other people's PRs waiting on your review.

A stack of PRs stays together, filed by its root PR. Review threads count only threads a person started; bot reviews are left out. Every column has a header, ruled off; a column no PR uses is hidden. Each row shows:

| Column | Meaning |
|---|---|
| PR | `PR#n`, clickable, opens the PR. Drafts are dimmed. |
| Repo, Title | Review requests also show the author. |
| Jira | The issue key, clickable once the Jira site is known (see below), and its status. Red when your open PR is on a Done issue. |
| CI | `✓` passing, `✗` failing, `●` running. `✗ 3` means three checks failed. |
| Status | Approved, Changes, Review or Draft. |
| Needs | What holds the PR, in words: `conflict`, `n unanswered` (threads whose last comment is someone else's), `n open` (threads waiting on the reviewer), `ticket closed`. Red when it's on you, yellow when it waits on others. Cut at 30 characters. |

Hover a row for the details, in a small box right of the card when the window has room: the branch to rebase on, the failed checks by name, and who wrote last on each open thread (`2 open: bob 1, you 1`). Click the note to open the PR, or its Checks tab when only checks failed.

Stacked PRs (base is not the default branch) are nested under the PR they build on. If that PR isn't listed, the row names its base branch.

## Jira status (optional)

Jira is not required. With a Jira MCP server connected, the status of each PR's issue appears next to its key, from one lookup with a 4 s timeout. With none, or if Jira doesn't answer, the Jira column is hidden and the header says "Jira unavailable". The PR list still shows.

The Jira server is detected from the tools it offers, with no configuration:

- the official Atlassian plugin (`searchJiraIssuesUsingJql`)
- `mcp-atlassian` (`jira_search`)
- any MCP tool whose name looks like a Jira search and takes `{jql}`

The key links to the issue once the site is known: from the Atlassian plugin's site list, or from the URL of the issues the server returns, so any of the servers above works.

## Only some repos (optional)

By default /pr shows every repo your `gh` login can see. To keep it to some GitHub owners, for example only your company's orgs on a work laptop, set **Only these GitHub owners** (`owners`) in the `/plugin` config menu: orgs or users, comma separated (`my-company, my-team-org`). Case doesn't matter. The value is kept in your Claude Code settings on that machine, so plugin updates leave it in place.

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

