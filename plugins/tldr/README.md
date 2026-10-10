# tldr

A Claude Code plugin that puts a short summary band above the prompt after a long answer, so you can see the outcome and what it needs from you without reading the whole thing.

## What it shows

| Line | Meaning |
|---|---|
| `✓` | One line: what happened. |
| `✔︎ verified:` | What the answer says was run or tested, and the result. Green for passes, red for failures, yellow for both. Left out when the answer reports nothing that was run. |
| `●` | Questions, decisions or actions waiting on you (up to 3), in yellow. |
| `·` | Other facts worth not missing (up to 2), dimmed. |

The header says how many lines the answer had and how many the summary has. `✕` dismisses the band. It also goes away when you submit the next prompt.

## Commands

| Command | Does |
|---|---|
| `/tldr` | Summarizes the last long answer again and prints the result in the chat. |
| `/tldr on` | Turns the automatic band on (the default). |
| `/tldr off` | Turns it off. `/tldr` still works on demand. |

The on/off choice is stored and survives restarts.

## How it works

An answer counts as long at 10 or more non-empty lines, or 800 or more characters. For each long answer from the main conversation (not subagents) it makes one Haiku call, low effort, 15 s timeout, with the first 24,000 characters of the answer. While it runs the band shows "summarizing…". If the call fails or times out, no band is shown. Short answers cost nothing.

The model is told to quote commands and tools exactly as the answer names them, and to leave out the verified line when nothing was run.

## Requirements

| Need | For |
|---|---|
| A recent Claude Code with mods (function-hook plugins) | everything |

## Privacy

The answer text is sent to Haiku for the summary, through the same Claude Code session. Nothing else leaves your machine.

## Development

```bash
claude plugin test plugins/tldr
claude plugin validate plugins/tldr
```
