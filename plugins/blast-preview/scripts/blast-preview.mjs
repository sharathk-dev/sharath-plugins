#!/usr/bin/env node
// PreToolUse hook (Bash): for a destructive command, ask with a preview of
// what it would change, so Claude Code's own prompt shows the files.
// Covers rm -r/-f, git reset --hard, git checkout/restore ., git clean.
// Any other command prints nothing and the normal rules apply. A preview that
// can't be measured still asks, and says so, rather than claiming "nothing".

import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const LIST_MAX = 8;

const exec = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 8000, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
const lines = (out) => out.split("\n").filter(Boolean);
// A shell pipeline with the path passed as $1, so nothing in it runs as shell.
const sh = (script, path, cwd) => exec("sh", ["-c", script, "sh", path], cwd);

const expand = (p, cwd) => {
  const home = p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p;
  return isAbsolute(home) ? home : resolve(cwd, home);
};

// Short form of a path: relative to the folder the command runs in, else ~/...
const short = (p, cwd) => {
  const rel = relative(cwd, p);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p;
};

function size(kb) {
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}

// Per top-level entry of $1: "files<TAB>KB<TAB>name<TAB>d|f". Empty folders count 0 files.
const BREAKDOWN = `find "$1" -mindepth 1 \\( -type f -printf '%P\\t%k\\tf\\n' \\) -o \\( -type d -printf '%P\\t0\\td\\n' \\) | awk -F'\\t' '
  { slash = index($1, "/"); top = slash ? substr($1, 1, slash - 1) : $1
    if (slash || $3 == "d") dir[top] = 1
    seen[top] = 1; kb[top] += $2; if ($3 == "f") n[top]++ }
  END { for (t in seen) printf "%d\\t%d\\t%s\\t%s\\n", n[t], kb[t], t, (t in dir) ? "d" : "f" }'`;

// Things worth a second look, found anywhere under $1 (not descending into .git).
const SENSITIVE = `find "$1" \\( -name .git -prune -print \\) -o \\( -type f \\( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name 'id_rsa*' -o -name 'id_ed25519*' -o -name '*.kdbx' \\) -print \\) | head -n 20`;

// The prompt shows a hook's reason as plain text (colour codes come out raw), so
// these are no-ops; they mark where colour would go if that ever changes.
const plain = (text) => text;
const PALETTE = [plain];
const dim = plain;
const warn = plain;

// A share bar: 20 cells of line glyphs, so rows don't merge into a block.
const bar = (share, colour) => {
  const filled = share > 0 ? Math.max(1, Math.round(share * 20)) : 0;
  const pct = share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
  return `${colour("━".repeat(filled))}${dim("─".repeat(20 - filled))}  ${dim(pct.padStart(4))}`;
};

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function rmPreview(args, cwd) {
  const flags = args.filter((a) => a.startsWith("-"));
  const recursive = flags.some((f) => f === "--recursive" || (/^-[^-]/.test(f) && /[rR]/.test(f)));
  const force = flags.some((f) => f === "--force" || (/^-[^-]/.test(f) && f.includes("f")));
  if (!recursive && !force) return null;
  const words = args.filter((a) => !a.startsWith("-"));
  // $VAR, $(...) and backticks only the shell can resolve; never call them "nothing".
  const unresolved = words.filter((a) => /[$`]/.test(a));
  if (unresolved.length > 0) {
    return { summary: `can't preview: ${unresolved.join(" ")} uses shell variables; check it before approving` };
  }
  // Globs expand the way the shell would, so `rm -rf build/*` shows what it matches.
  const targets = words.flatMap((a) => {
    const path = expand(a, cwd);
    return /[*?[]/.test(a) ? globSync(path).map((p) => resolve(p)) : [path];
  });
  if (targets.length === 0) {
    return { summary: `would delete nothing: ${words.join(" ")} matches no files` };
  }
  const existing = targets.filter((t) => existsSync(t));
  if (existing.length === 0) {
    return { summary: `would delete nothing: ${targets.map((t) => short(t, cwd)).join(" ")} doesn't exist` };
  }
  try {
    // One find pass per target, summed per top-level entry by awk, so even a
    // huge tree comes back as a few lines: files, KB on disk, entry name.
    // One folder: break it down by what's inside. Several targets: one row each.
    const rows = [];
    for (const t of existing) {
      if (!statSync(t).isDirectory()) {
        rows.push({ name: basename(t), files: 1, kb: Math.ceil(statSync(t).size / 1024), dir: false });
        continue;
      }
      const inside = lines(sh(BREAKDOWN, t, cwd)).map((line) => {
        const [files, kb, name, dir] = line.split("\t");
        return { name, files: Number(files), kb: Number(kb), dir: dir === "d" };
      });
      if (existing.length === 1) {
        rows.push(...inside);
      } else {
        const sum = (key) => inside.reduce((n, r) => n + r[key], 0);
        rows.push({ name: basename(t), files: sum("files"), kb: sum("kb"), dir: true });
      }
    }
    rows.sort((a, b) => b.kb - a.kb || b.files - a.files);
    const total = rows.reduce((n, r) => n + r.files, 0);
    const kb = rows.reduce((n, r) => n + r.kb, 0);
    const width = Math.min(30, Math.max(...rows.map((r) => r.name.length + (r.dir ? 1 : 0)), 0));
    const fileWidth = Math.max(...rows.map((r) => (r.dir ? plural(r.files, "file").length : 0)), 0);
    // Share by size, or by file count when everything is empty.
    const share = (r) => (kb > 0 ? r.kb / kb : total > 0 ? r.files / total : 0);
    const items = rows.map((r, i) => {
      const colour = PALETTE[i % PALETTE.length];
      const name = (r.dir ? `${r.name}/` : r.name).padEnd(width);
      const count = (r.dir ? plural(r.files, "file") : "").padStart(fileWidth);
      return `${colour(name)}  ${dim(count)}  ${size(r.kb).padStart(8)}  ${bar(share(r), colour)}`;
    });
    return { summary: `would delete ${plural(total, "file")} (${size(kb)})`, warnings: warningsFor(existing, cwd), items, total: items.length };
  } catch {
    return { summary: `couldn't measure what this would delete in ${existing.map((t) => short(t, cwd)).join(" ")}; check it before approving` };
  }
}

// Warn about a git repository (and its uncommitted work) or secret-looking files.
function warningsFor(targets, cwd) {
  const repos = [];
  const secrets = [];
  for (const t of targets) {
    if (!statSync(t).isDirectory()) {
      if (/^(\.env(\..*)?|.*\.(pem|key|kdbx)|id_(rsa|ed25519).*)$/.test(basename(t))) secrets.push(basename(t));
      continue;
    }
    for (const found of lines(sh(SENSITIVE, t, cwd))) {
      const rel = relative(targets.length === 1 ? t : dirname(t), found) || basename(found);
      if (basename(found) === ".git") repos.push({ rel, root: dirname(found) });
      else secrets.push(rel);
    }
  }
  const warnings = repos.slice(0, 3).map(({ rel, root }) => {
    let changes = 0;
    try {
      changes = lines(exec("git", ["status", "--porcelain"], root)).length;
    } catch {
      // not a readable repository; still worth the warning
    }
    const where = rel === ".git" ? "a git repository" : `a git repository (${dirname(rel)}/)`;
    return changes > 0 ? `${where} with ${plural(changes, "uncommitted change")}` : where;
  });
  if (repos.length > 3) warnings.push(`+ ${repos.length - 3} more git repositories`);
  if (secrets.length > 0) {
    const named = secrets.slice(0, 3).join(", ");
    warnings.push(`secret-looking files: ${named}${secrets.length > 3 ? ` + ${secrets.length - 3} more` : ""}`);
  }
  return warnings;
}

function gitPreview(sub, rest, cwd) {
  let found = null;
  let what = "";
  if (sub === "reset" && rest.includes("--hard")) {
    found = lines(exec("git", ["status", "--porcelain"], cwd));
    what = "would discard uncommitted changes in";
  } else if ((sub === "checkout" || sub === "restore") && rest.includes(".")) {
    found = lines(exec("git", ["diff", "--name-only"], cwd));
    what = "would discard unstaged changes in";
  } else if (sub === "clean") {
    const flags = rest.filter((a) => a.startsWith("-") && a !== "-f" && a !== "--force");
    found = lines(exec("git", ["clean", "-n", ...flags], cwd)).map((l) => l.replace(/^Would remove /, ""));
    what = "would remove untracked";
  }
  if (found === null || found.length === 0) return null;
  return { summary: `${what} ${plural(found.length, sub === "clean" ? "path" : "file")}`, items: found, total: found.length };
}

function preview(command, cwd) {
  let dir = cwd;
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^["']|["']$/g, ""));
    while (words[0] === "sudo" || /^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
    const [cmd, ...args] = words;
    if (cmd === "cd") {
      dir = expand(args[0] ?? "~", dir);
    } else if (cmd === "rm" || cmd?.endsWith("/rm")) {
      const p = rmPreview(args, dir);
      if (p) return p;
    } else if (cmd === "git") {
      let i = 0;
      let gitDir = dir;
      while (args[i]?.startsWith("-")) {
        if (args[i] === "-C") gitDir = expand(args[++i], gitDir);
        i += 1;
      }
      const p = gitPreview(args[i], args.slice(i + 1), gitDir);
      if (p) return p;
    }
  }
  return null;
}

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const result = preview(String(input.tool_input?.command ?? ""), input.cwd ?? process.cwd());
  if (result) {
    const items = result.items ?? [];
    const shown = items.slice(0, LIST_MAX).map((f) => `  ${f}`);
    const total = result.total ?? items.length;
    if (total > shown.length) shown.push(`  + ${(total - shown.length).toLocaleString()} more`);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: [
          `Blast radius: ${result.summary}`,
          ...(result.warnings ?? []).map((w) => `  ${warn(`⚠ ${w}`)}`),
          ...shown,
        ].join("\n"),
      },
    }));
  }
} catch {
  // a git command outside a repo and the like: no preview; the normal permission rules apply
}
