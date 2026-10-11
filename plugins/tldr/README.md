# tldr

A Claude Code plugin that adds a short TL;DR card under a long answer in the transcript, so you can see the outcome and what it needs from you without reading the whole thing.

## What it shows

The card condenses the whole answer so you understand it at a glance. The model picks the layout that fits your request:

| Layout | For | Card |
|---|---|---|
| `ANSWER` | A question or explanation | A bold one-line answer, then 2 to 4 `·` bullets with the key facts. |
| `TABLE` | A breakdown, comparison or per-item result | A bold verdict, then one table (up to 4 columns and 6 rows) with a magenta header. |
| `STEPS` | A how-to | A bold goal, then numbered steps with the exact `commands` in cyan. |
| `WORK` | Files changed, things run | `✓` done in green, `✗` failed in red, `○` not done or blocked dimmed. |

For any layout, `●` lines in yellow (up to 3) hold the questions or actions waiting on you. In `WORK` they come first, followed by the lines and the dim `Steps: a › b › c` line naming the steps of the turn (the task list, or the tool calls when there was none; repeats show as `×3`), cut to one line with `+N more`. The other layouts put the `●` lines last and have no Steps line.

The card sits under the last block of the answer it summarizes, so it scrolls with the history, and every past answer (the last 20) keeps its own card. It spans the full width, and the time the turn took is in the header, top right. While the summary is being generated a dim `summarizing…` line shows in its place. Cards saved by an older version (done, verified, notes) are drawn as `WORK` cards.

## Modes

| Mode | Transcript |
|---|---|
| `off` | The plugin stays out of the way: no automatic summary (so no Haiku call), no card, no `summarizing…` line, no progress band and no plan instruction. Cards already made are not drawn either. `/tldr` still works on demand. |
| `full` (default) | The long answer is shown in full, with the card under it. |
| `tldr` | A summarized answer (the last 20) is folded to one dim line, `▸ answer folded (N lines) · TL;DR below · /tldr full to show`, followed by the card. Answers still being summarized, short answers and answers whose summary failed show as normal. |

A folded answer stays folded until the mode changes. Folding changes only the drawing: ctrl+o shows the full stored answer.

## Default mode

The `defaultView` setting (`off`, `full` or `tldr`; default `full`) is the mode each session starts in. It is a row in the plugin's config menu, or set it in settings:

```json
{ "pluginConfigs": { "tldr": { "options": { "defaultView": "tldr" } } } }
```

Changes made with the footer switch or `/tldr` last for the session only; the next session starts from the setting again.

## Footer switch

A switch at the right end of the prompt footer, beside the mode labels, reads `off · full · TL;DR`: the current mode is drawn in the title gradient, the others dim; click one to switch the whole transcript. It is always shown, so `off` can be turned back on.

## Commands

| Command | Does |
|---|---|
| `/tldr` | Summarizes the last long answer again, refreshes its card and shows the result in the chat as the same card. Works in any mode, `off` included. |
| `/tldr off` | Sets the `off` mode for this session. |
| `/tldr full` | Sets the `full` mode (`/tldr on` is an alias). |
| `/tldr only` | Sets the `tldr` mode: folds summarized answers, so you read only the card. |

## Live progress band (tldr mode)

In the `tldr` mode the band above the prompt is a live progress card while Claude works. When the turn ends it returns the slot to Claude Code, so nothing of the plugin is left above the prompt. The `full` and `off` modes never draw the band.

```
╭──────────────────────────────────────────────────────────────────────────╮
│ ⠹ Build the weather dashboard                                        23s │
│ Step 2 of 3                                                              │
│ ✓ Pick the page style and layout          Done                           │
│ ● Build the weather dashboard    ░▒▓█     Working                        │
│ ○ Publish it and share the link           Next                           │
╰──────────────────────────────────────────────────────────────────────────╯
```

In `tldr` mode the plugin adds a short instruction to the system prompt: for anything that takes more than one tool call, Claude first writes a plan of 3 to 7 plainly named steps and ticks them off as it goes, so the band reads `Step 2 of 5` from the start. The other modes add nothing. Steps come from Claude's own task list: `TodoWrite` (whole list), or `TaskCreate` plus `TaskUpdate` (matched by id). The step in progress carries a short moving trail; finished steps get `✓ Done`. Up to 6 steps show, then `+N more`. With no task list, `Understanding your request` shows until the first tool call; then each tool call is a step, named by what it is for: a shell command by the description Claude gives it (`Find percentage assertions in tests`), other tools in plain words (`Reading Foo.java`, `Searching for "steps"`). Each is `Working` until it returns and `Done` after; the latest 6 show, with `+N earlier` above. Subagent tool calls are ignored.

When the turn ends, the finished-turn information moves into the TL;DR card under the answer: its time and its steps line show in the card header and footer. The spinner and timer tick about every 250 ms only while a turn runs.

## How it works

An answer counts as long at 12 or more non-empty lines, or 1,200 or more characters. Unless the mode is `off`, for each long answer from the main conversation (not subagents) it makes one Haiku call, low effort, 15 s timeout, with your request (the turn's prompt, first 2,000 characters) and the first 24,000 characters of the answer. `/tldr` sends the request of the answer it re-summarizes. While it runs the answer shows "summarizing…". If the call fails or times out, no card is shown. Short answers cost nothing.

The instructions to the model live in `hooks/prompt.ts`; edit them to change the style of the cards. The reply starts with a `LAYOUT:` line and is parsed leniently: a missing layout defaults to `ANSWER` (or `TABLE` when a table is present), and a wrapping code fence, headings and a `TL;DR` label are dropped.

## Requirements

| Need | For |
|---|---|
| A recent Claude Code with mods (function-hook plugins) | everything |

## Privacy

Your request and the answer text are sent to Haiku for the summary, through the same Claude Code session. Nothing else leaves your machine.

## Development

```bash
claude plugin test plugins/tldr
claude plugin validate plugins/tldr
```
