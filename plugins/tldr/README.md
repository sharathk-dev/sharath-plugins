# tldr

A Claude Code plugin that adds a short TL;DR card under a long answer in the transcript, so you can see the outcome and what it needs from you without reading the whole thing.

## What it shows

| Line | Meaning |
|---|---|
| `✓` | One line: what happened. |
| `✔︎ verified:` | What the answer says was run or tested, and the result. Green for passes, red for failures, yellow for both. Left out when the answer reports nothing that was run. |
| `●` | Questions, decisions or actions waiting on you (up to 3), in yellow. |
| `·` | Other facts worth not missing (up to 2), dimmed. |

The card sits under the last block of the answer it summarizes, so it scrolls with the history, and every past answer (the last 20) keeps its own card. It spans the full width and long lines wrap instead of being cut off. The header says how many lines the answer had and how many the summary has. While the summary is being generated a dim `summarizing…` line shows in its place.

## Commands

| Command | Does |
|---|---|
| `/tldr` | Summarizes the last long answer again, refreshes its card and shows the result in the chat as the same card. |
| `/tldr on` | Turns automatic summaries on (the default). |
| `/tldr off` | Turns it off. `/tldr` still works on demand. |
| `/tldr only` | Folds summarized answers in the transcript, so you read only the card. |
| `/tldr full` | Shows full answers again (the default). |

The on/off and view choices are stored and survive restarts.

## View toggle

A switch at the right end of the prompt footer, beside the mode labels, reads `TL;DR · full`: the current view is drawn in the title gradient, the other dim; click the dim one to switch the whole transcript. It appears once an answer has been summarized. `/tldr only` and `/tldr full` do the same.

| View | Transcript |
|---|---|
| `full` (default) | The long answer is shown in full, with the card under it. |
| `tldr` | A summarized answer (the last 20) is folded to one dim line, `▸ answer folded (N lines) · TL;DR below · /tldr full to show`, followed by the card. Answers still being summarized, short answers and answers whose summary failed show as normal. |

A folded answer stays folded until the view changes. Folding changes only the drawing: ctrl+o shows the full stored answer.

## Live progress band (tldr view)

In the `tldr` view the band above the prompt is a live progress card while Claude works. When the turn ends it returns the slot to Claude Code, so nothing of the plugin is left above the prompt. The `full` view never draws the band.

```
╭──────────────────────────────────────────────────────────────────────────╮
│ ⠹ Build the weather dashboard                                        23s │
│ Step 2 of 3                                                              │
│ ✓ Pick the page style and layout          Done                           │
│ ● Build the weather dashboard    ░▒▓█     Working                        │
│ ○ Publish it and share the link           Next                           │
╰──────────────────────────────────────────────────────────────────────────╯
```

In TL;DR view the plugin adds a short instruction to the system prompt: for anything that takes more than one tool call, Claude first writes a plan of 3 to 7 plainly named steps and ticks them off as it goes, so the band reads `Step 2 of 5` from the start. Full view adds nothing. Steps come from Claude's own task list: `TodoWrite` (whole list), or `TaskCreate` plus `TaskUpdate` (matched by id). The step in progress carries a short moving trail; finished steps get `✓ Done`. Up to 6 steps show, then `+N more`. With no task list, `Understanding your request` shows until the first tool call; then each tool call is a step, named by what it is for: a shell command by the description Claude gives it (`Find percentage assertions in tests`), other tools in plain words (`Reading Foo.java`, `Searching for "steps"`). Each is `Working` until it returns and `Done` after; the latest 6 show, with `+N earlier` above. Subagent tool calls are ignored.

When the turn ends, the finished-turn information moves into the TL;DR card under the answer: in the `tldr` view its header carries a green `✓ All done · took 1m 47s` line with the step count. The spinner and timer tick about every 250 ms only while a turn runs.

## How it works

An answer counts as long at 12 or more non-empty lines, or 1,200 or more characters. For each long answer from the main conversation (not subagents) it makes one Haiku call, low effort, 15 s timeout, with the first 24,000 characters of the answer. While it runs the answer shows "summarizing…". If the call fails or times out, no card is shown. Short answers cost nothing.

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
