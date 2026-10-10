export type Spec = { kind: 'last' } | { kind: 'yesterday' } | { kind: 'today' } | { kind: 'days'; days: number }

export function parseArgs(args: string): Spec | { error: string } {
  const a = args.trim().toLowerCase()
  if (a === '') return { kind: 'last' }
  if (a === 'yesterday') return { kind: 'yesterday' }
  if (a === 'today') return { kind: 'today' }
  const m = a.match(/^(\d{1,3})d$/)
  if (m && Number(m[1]) >= 1) return { kind: 'days', days: Number(m[1]) }
  return { error: `Unknown argument "${args.trim()}". Use /standup, /standup yesterday, /standup today or /standup 3d` }
}

export type Win = { from: Date; to: Date; label: string; word: string }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function startOfDay(d: Date, back = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back)
}

export const dayLabel = (d: Date) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`

export function rangeLabel(from: Date, to: Date): string {
  if (from.getMonth() !== to.getMonth()) return `${dayLabel(from)} – ${dayLabel(to)}`
  return `${DAYS[from.getDay()]} ${from.getDate()} – ${dayLabel(to)}`
}

export function windowFor(now: Date, spec: Spec): Win {
  if (spec.kind === 'yesterday') {
    const from = startOfDay(now, 1)
    return { from, to: startOfDay(now), label: dayLabel(from), word: 'Yesterday' }
  }
  if (spec.kind === 'last') {
    const monday = now.getDay() === 1
    const from = startOfDay(now, monday ? 3 : 1)
    return { from, to: now, label: rangeLabel(from, now), word: monday ? 'Since Friday' : 'Since yesterday' }
  }
  if (spec.kind === 'today') return { from: startOfDay(now), to: now, label: `${dayLabel(now)} (today)`, word: 'Today so far' }
  const from = startOfDay(now, spec.days)
  return { from, to: now, label: `last ${spec.days} days, ${dayLabel(from)} - ${dayLabel(now)}`, word: `Last ${spec.days} days` }
}

const pad = (n: number) => String(n).padStart(2, '0')
export const jqlDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`

export function jiraJql(w: Win): string {
  const during = `DURING ("${jqlDate(w.from)}", "${jqlDate(w.to)}")`
  return `status CHANGED BY currentUser() ${during} ORDER BY updated DESC`
}

export type CommitRepo = { repo: string; count: number; messages: string[] }
export type PrKind = 'merged' | 'opened' | 'reviewed'
export type PrItem = { kind: PrKind; repo: string; number: number; url: string; title: string }
export type JiraItem = { key: string; url: string; summary: string; status: string; category: string }
export type Report = { label: string; word: string; jiraDown: boolean; commits: CommitRepo[]; prs: PrItem[]; jira: JiraItem[] }

export const totalCommits = (r: Report) => r.commits.reduce((n, c) => n + c.count, 0)
export const isEmpty = (r: Report) => totalCommits(r) === 0 && r.prs.length === 0 && r.jira.length === 0

const clean = (s: string) => s.replace(/ · /g, ' - ').replace(/\s*\n\s*/g, ' ').trim()

// Text form, readable for the model and read back to draw:
//   Standup · Fri 9 Oct · Jira unavailable
//   ### Commits (7)
//   - web (3): Add modulo · Fix divide
//   ### PRs
//   - merged [web#2](url) Title
//   ### Jira
//   - [KAN-3](url) Summary · In Review/In Progress      (`<status>/<category>`)
// The word for the day ("Yesterday") travels in the header's `{...}` so the draft can use it.
export function toText(r: Report): string {
  if (isEmpty(r)) return `Nothing found for ${r.label}${r.jiraDown ? ' · Jira unavailable' : ''}`
  const out = [`Standup · ${r.label}${r.jiraDown ? ' · Jira unavailable' : ''} · {${r.word}}`]
  if (r.commits.length > 0) {
    out.push(`### Commits (${totalCommits(r)})`)
    for (const c of r.commits) out.push(`- ${c.repo} (${c.count}): ${c.messages.map(clean).join(' · ')}`)
  }
  if (r.prs.length > 0) {
    out.push('### PRs')
    for (const p of r.prs) out.push(`- ${p.kind} [${p.repo}#${p.number}](${p.url}) ${clean(p.title)}`)
  }
  if (r.jira.length > 0) {
    out.push('### Jira')
    for (const j of r.jira) {
      const key = j.url ? `[${j.key}](${j.url})` : j.key
      out.push(`- ${key} ${clean(j.summary)} · ${clean(j.status)}/${j.category}`)
    }
  }
  return out.join('\n')
}

export function fromText(text: string): Report | undefined {
  // The transcript row carries the text under the plugin's name: "standup: Standup · …".
  const lines = text.replace(/^standup: /, '').split('\n')
  const nothing = lines[0]?.match(/^Nothing found for (.*?)( · Jira unavailable)?$/)
  if (nothing) return { label: nothing[1]!, word: '', jiraDown: Boolean(nothing[2]), commits: [], prs: [], jira: [] }
  const head = lines[0]?.match(/^Standup · (.*?)( · Jira unavailable)? · \{(.*)\}$/)
  if (!head) return undefined
  const r: Report = { label: head[1]!, word: head[3]!, jiraDown: Boolean(head[2]), commits: [], prs: [], jira: [] }
  let section = ''
  for (const l of lines.slice(1)) {
    if (l.startsWith('### ')) {
      section = l.slice(4).split(' ')[0]!
      continue
    }
    if (section === 'Commits') {
      const m = l.match(/^- (.+?) \((\d+)\): ?(.*)$/)
      if (m) r.commits.push({ repo: m[1]!, count: Number(m[2]), messages: m[3] ? m[3].split(' · ') : [] })
    } else if (section === 'PRs') {
      const m = l.match(/^- (merged|opened|reviewed) \[([^\]]*)#(\d+)\]\(([^)]+)\) (.*)$/)
      if (m) r.prs.push({ kind: m[1] as PrKind, repo: m[2]!, number: Number(m[3]), url: m[4]!, title: m[5]! })
    } else if (section === 'Jira') {
      const m = l.match(/^- (?:\[([^\]]+)\]\(([^)]+)\)|(\S+)) (.*) · (.*)\/([^/]*)$/)
      if (m) r.jira.push({ key: m[1] ?? m[3]!, url: m[2] ?? '', summary: m[4]!, status: m[5]!, category: m[6]! })
    }
  }
  return r
}

export function draftOf(r: Report): string {
  const done: string[] = []
  const n = totalCommits(r)
  if (n > 0) {
    const msgs = r.commits.flatMap(c => c.messages).slice(0, 3)
    const repos = r.commits.map(c => c.repo).join(', ')
    done.push(`- ${n} commit${n === 1 ? '' : 's'} in ${repos}${msgs.length ? ` (${msgs.join('; ')})` : ''}`)
  }
  const verb: Record<PrKind, string> = { merged: 'Merged', opened: 'Opened', reviewed: 'Reviewed' }
  for (const p of r.prs) done.push(`- ${verb[p.kind]} ${p.repo}#${p.number} ${p.title}`)
  for (const j of r.jira) done.push(`- ${j.key} ${j.summary} -> ${j.status}`)
  const next = r.jira.filter(j => j.category === 'In Progress').map(j => `continue ${j.key} ${j.summary}`)
  return [`${r.word || 'Yesterday'}:`, ...done, '', `Today: ${next.join('; ')}`.trimEnd(), 'Blockers: none'].join('\n')
}
