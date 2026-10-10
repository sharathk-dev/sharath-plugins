# sharath-plugins

Personal Claude Code plugins.

| Plugin | What it does |
|---|---|
| [jira-tasks](plugins/jira-tasks/README.md) | `/jira` shows your open Jira issues as a card in the chat, with their open PRs. |
| [pr-status](plugins/pr-status/README.md) | `/pr` shows your open PRs and review requests as a card in the chat: review threads, CI, conflicts, stacked PRs, Jira status. |
| [standup](plugins/standup/README.md) | `/standup` shows what you did since yesterday as one card: GitHub commits, PRs and Jira tickets, with a button to draft the update. |
| [test-watcher](plugins/test-watcher/README.md) | Compact card and compact model-facing summary for Maven and Gradle test runs; the full log is saved to a file. |
| [tldr](plugins/tldr/README.md) | TL;DR card under long answers in the transcript. |
| [blast-preview](plugins/blast-preview/README.md) | Shows what a destructive shell command would delete or discard, inside Claude Code's permission prompt. |

## Install

In Claude Code:

```text
/plugin marketplace add sharathk-dev/sharath-plugins
/plugin install jira-tasks@sharath-plugins
/plugin install pr-status@sharath-plugins
/plugin install blast-preview@sharath-plugins
/plugin install standup@sharath-plugins
/plugin install test-watcher@sharath-plugins
/plugin install tldr@sharath-plugins
```

Or from a shell:

```bash
claude plugin marketplace add sharathk-dev/sharath-plugins
claude plugin install jira-tasks@sharath-plugins
claude plugin install pr-status@sharath-plugins
claude plugin install blast-preview@sharath-plugins
claude plugin install standup@sharath-plugins
claude plugin install test-watcher@sharath-plugins
claude plugin install tldr@sharath-plugins
```

## Update

```bash
claude plugin marketplace update sharath-plugins
```

## Developing

Each plugin lives in its own folder under `plugins/`.

```bash
claude plugin validate plugins/<name>     # check a plugin's manifest
claude plugin test plugins/<name>         # run a plugin's tests
claude plugin marketplace add ./          # use this checkout as a local marketplace
```

## License

MIT
