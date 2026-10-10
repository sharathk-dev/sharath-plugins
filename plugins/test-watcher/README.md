# test-watcher

A Claude Code plugin that watches Maven and Gradle test runs in Bash. A long run is saved to a log file and replaced, for the model, by a compact summary and the path of the log. In the terminal the run shows as a card: pass or fail counts, the failing tests and where they failed.

## What it shows

For a Bash command that runs Maven or Gradle tests (`mvn test`, `./mvnw verify`, `./gradlew test`, `gradle :app:test --tests ...`, also inside a `&&` chain), the tool call becomes:

| Part | Meaning |
|---|---|
| `● Bash(command)` | The command, as in the engine's own row. Green or red dot. |
| `✓ 3 passed · 0.8s` | A passing run. Red `✗ 2 failed · 2 passed · 1 skipped · 0.8s` when tests fail. |
| `✗ build error` | The build itself broke (compile error, dependency resolution). The first error lines follow. |
| `✗ Class.test  File.java:13  message` | One row per failing test, at most 8, then `+n more`. |
| `full log: ~/.cache/test-watcher/...` | Where the whole output was saved. Only for long runs. |

## How it works

- Output of 40 lines or more is saved in full to `$XDG_CACHE_HOME/test-watcher/` or `~/.cache/test-watcher/`, one `.log` file per run. After each save only the newest 50 logs are kept; older ones are deleted.
- For those long runs it rewrites what Claude reads: instead of the build output, the model gets one compact summary (command, PASSED or FAILED, counts, time), the failing tests with file, line and message, and `Full log: <path>`. Stack traces are left out; the model can read the log when it needs more. A failed run keeps its `Exit code` line.
- Output shorter than 40 lines is left as it is, and the card is still drawn.
- Output that can't be parsed as Maven or Gradle results is left alone and gets no card.
- If anything fails (parsing, writing the log, pruning old logs), the original result goes through unchanged.

## Requirements

| Need | For |
|---|---|
| A recent Claude Code with mods (function-hook plugins) | everything |
| Maven or Gradle (including `mvnw` and `gradlew`) | the runs it recognizes |
| `rm` on the PATH | pruning old logs |

## Privacy

Logs contain the full build output and stay on your machine, in the cache directory above. Pruning runs `rm -f` only on `*.log` files it listed in that directory. Nothing is sent anywhere.

## Development

```bash
claude plugin test plugins/test-watcher
claude plugin validate plugins/test-watcher
```

## Limits

- Only Maven and Gradle. Other test runners are not touched.
- Commands that only mention `mvn` (for example `grep mvn pom.xml`) or skip tests (`-DskipTests`) are ignored.
