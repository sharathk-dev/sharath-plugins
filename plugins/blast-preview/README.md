# blast-preview

A Claude Code plugin that shows what a destructive shell command would delete or discard, inside Claude Code's own permission prompt.

```text
Hook PreToolUse:Bash requires confirmation for this command:
Blast radius: would delete 35 files (6.8 MB)
  ⚠ a git repository with 6 uncommitted changes
  ⚠ secret-looking files: .env, src/server.key
  node_modules/   2 files    5.7 MB  █████████████████░░░   84%
  dist/            1 file    980 KB  ███░░░░░░░░░░░░░░░░░   14%
  .git/          28 files    116 KB  ░░░░░░░░░░░░░░░░░░░░    2%
  src/            3 files     12 KB  ░░░░░░░░░░░░░░░░░░░░   <1%
```

## What it covers

| Command | Preview |
|---|---|
| `rm` with `-r` or `-f` | Files and size per top-level entry, biggest first, with a share bar. Globs are expanded. Warns about git repositories (with uncommitted work) and secret-looking files (`.env`, `*.pem`, `*.key`, SSH keys). |
| `git reset --hard` | Files with uncommitted changes |
| `git checkout .`, `git restore .` | Files with unstaged changes |
| `git clean` | Untracked paths it would remove |

Every other command passes through untouched, and your permission rules apply as usual.

## How it works

A `PreToolUse` hook on `Bash` runs `scripts/blast-preview.mjs`. For a covered command it measures what would change and answers `ask`, with the preview as the reason, which Claude Code shows in its prompt. It only reads: it never changes files.

- A path it can't resolve (`$VAR`, `$(...)`) gets "can't preview", never "nothing".
- If measuring fails, it still asks and says it couldn't measure.
- If the script itself fails or times out (10 s), it prints nothing and your normal permission rules apply.

**Permission rules win over the hook's text.** If a `permissions.ask` rule also matches the command (for example `Bash(rm -rf *)`), Claude Code shows the rule's message instead of the preview. Remove those rules to see the preview; the hook asks for those commands anyway.

## Install

```bash
/plugin marketplace add sharathk-dev/sharath-plugins
/plugin install blast-preview@sharath-plugins
```

Turn it off or on with `/plugin`.

## Requirements

Node.js 22 or later (`fs.globSync`), and GNU `find`, `awk` and `du` (Linux).

## Limits

- It reads the command as plain words split on `&&`, `||`, `;` and `|`. It doesn't understand shell quoting, so text like `echo "rm -rf x"` also triggers a prompt (harmless: it errs toward asking).
- Sizes are disk usage (`du`/`%k`), so tiny files count as 4 KB.
