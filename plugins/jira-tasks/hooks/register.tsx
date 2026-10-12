import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// Cards fill the window up to CARD_MAX; with no window size known, CARD_WIDTH.
const CARD_WIDTH = 100
const CARD_MAX = 160

const GRADIENT = [
  [255, 95, 162],
  [217, 70, 239],
  [96, 165, 250],
]

function gradientColor(i: number, n: number): string {
  const pos = (n <= 1 ? 0 : i / (n - 1)) * (GRADIENT.length - 1)
  const k = Math.min(GRADIENT.length - 2, Math.floor(pos))
  const mix = GRADIENT[k]!.map((c, j) => Math.round(c + (GRADIENT[k + 1]![j]! - c) * (pos - k)))
  return `#${mix.map(c => c.toString(16).padStart(2, '0')).join('')}`
}

import type { PullRequest, Task } from '../types'

const JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'

const cloud = atom({ plugin: 'jira-tasks', key: 'cloudId' } as const, '')
const siteUrl = atom({ plugin: 'jira-tasks', key: 'site' } as const, '')

// Jira files every status, however a board names it, under one of three categories; its own boards colour by them.
type Category = 'To Do' | 'In Progress' | 'Done' | ''

// Category from Jira's REST shape (`statusCategory.key`) or a flattened one (`category: "In Progress"`).
function categoryOf(status: any): Category {
  const raw = String(status?.statusCategory?.key ?? status?.statusCategory?.name ?? status?.category ?? '').toLowerCase()
  if (raw === 'new' || raw === 'to do') return 'To Do'
  if (raw === 'indeterminate' || raw === 'in progress') return 'In Progress'
  if (raw === 'done') return 'Done'
  return ''
}

// For colour and order only, when the server sent no category: a guess from the status name, never printed.
function guessCategory(status: string): Category {
  const name = status.toLowerCase()
  if (/progress|doing|review|qa|test|block|hold/.test(name)) return 'In Progress'
  if (/to do|todo|open|backlog|new|triage/.test(name)) return 'To Do'
  if (/done|closed|resolved/.test(name)) return 'Done'
  return ''
}

// Names that mean "needs attention" stand out within their category; everything else takes its category's colour.
function colourFor(status: string, known: Category): string {
  const category = known || guessCategory(status)
  const s = status.toLowerCase()
  if (/block|imped|hold/.test(s)) return 'red'
  if (/review|qa|test|verif/.test(s)) return 'magenta'
  if (category === 'In Progress') return 'yellow'
  if (category === 'To Do') return 'cyan'
  if (category === 'Done') return 'green'
  return 'white'
}

// Work under way first, then waiting work; within a category, blocked and review ahead of the rest.
function rank(status: string, known: Category): number {
  const category = known || guessCategory(status)
  const byCategory = category === 'In Progress' ? 0 : category === 'To Do' ? 2 : category === 'Done' ? 3 : 1
  const colour = colourFor(status, category)
  return byCategory * 10 + (colour === 'red' ? 0 : colour === 'magenta' ? 1 : 2)
}

// Search tools of known Jira MCP servers, and the arguments each takes. A server is recognised by the tool it
// offers, not its name, so a company build of either server is picked up too; failing both, any MCP tool named
// like a Jira search (`jira_search_issues`, `searchJira`) is tried with just `{ jql }`.
type Adapter = {
  tool: string
  args: (jql: string, cloudId: string, fields: string[], limit: number, pageToken?: string) => Record<string, unknown>
  needsCloudId: boolean
  paged?: boolean
}
const ADAPTERS: Adapter[] = [
  // Atlassian's own remote MCP (the `atlassian` plugin).
  {
    tool: 'searchJiraIssuesUsingJql',
    needsCloudId: true,
    paged: true,
    args: (jql, cloudId, fields, limit, pageToken) => ({ cloudId, jql, fields, maxResults: limit, view: 'evidence', ...(pageToken ? { nextPageToken: pageToken } : {}) }),
  },
  // sooperset/mcp-atlassian, common for self-hosted Jira Server / Data Center.
  { tool: 'jira_search', needsCloudId: false, args: (jql, _cloudId, fields, limit) => ({ jql, fields: fields.join(','), limit }) },
]

type Source = { server: string; adapter: Adapter }

const TASK_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'parent']

const PAGE_SIZE = 25

const LOOKS_LIKE_JIRA_SEARCH = /jira.*search|search.*jira/i

// MCP tools reach the model as `mcp__<server>__<tool>`; $.mcp.call accepts that server spelling.
async function detect($: EngineInterface): Promise<Source> {
  const tools = (await $.tool.list()).filter(t => t.mcp && t.name.startsWith('mcp__')).map(t => {
    const rest = t.name.slice('mcp__'.length)
    const cut = rest.lastIndexOf('__')
    return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) }
  })
  for (const adapter of ADAPTERS) {
    const hit = tools.find(t => t.tool === adapter.tool)
    if (hit) return { server: hit.server, adapter }
  }
  const guess = tools.find(t => LOOKS_LIKE_JIRA_SEARCH.test(t.tool))
  if (guess) return { server: guess.server, adapter: { tool: guess.tool, needsCloudId: false, args: jql => ({ jql }) } }
  throw new Error('no Jira MCP server connected (no Jira search tool found). Check /mcp')
}

// MCP servers answer with a text block holding JSON, or, when it's large, a note naming the file it was saved to.
const SAVED_TO = /saved to:?\s+[`'"]?([^\s`'"]+?)[`'"]?\.?(?:\s|$)/i

async function parse($: EngineInterface, result: { content: { type: string; text?: string }[]; isError: boolean }): Promise<any> {
  const texts = result.content.filter(block => block.type === 'text').map(block => block.text ?? '')
  if (result.isError) throw new Error(texts.join('\n') || 'the Jira server reported an error')
  for (const text of texts) {
    try {
      return JSON.parse(text)
    } catch {}
  }
  const text = texts.join('\n')
  const saved = text.match(SAVED_TO)?.[1]
  if (saved) {
    const file = await $.fs.read(saved)
    try {
      const json = JSON.parse(file)
      const inner = Array.isArray(json) ? json.find(block => block?.type === 'text')?.text : undefined
      return typeof inner === 'string' ? JSON.parse(inner) : json
    } catch {
      throw new Error(`the Jira reply saved to ${saved} is not JSON (${file.length} chars)`)
    }
  }
  const start = text.replace(/\s+/g, ' ').trim().slice(0, 160)
  throw new Error(`the Jira reply was cut off or not JSON (${text.length} chars): ${start}`)
}

const listOf = (v: any): any[] => (Array.isArray(v) ? v : Array.isArray(v?.nodes) ? v.nodes : [])

function group(tasks: Task[]): [string, Task[]][] {
  const groups = new Map<string, Task[]>()
  for (const t of tasks) groups.set(t.status, [...(groups.get(t.status) ?? []), t])
  const cat = (status: string) => groups.get(status)![0]!.category
  return [...groups.entries()].sort(([x], [y]) => rank(x, cat(x)) - rank(y, cat(y)))
}

const nameOf = (v: any): string => (typeof v === 'string' ? v : (v?.name ?? ''))

// Reads both shapes: Jira's REST issue (`fields.status.name`) and flattened ones (`status`, `issue_type`).
function toTask(i: any, site: string): Task {
  const f = i.fields ?? i
  const origin = typeof i.self === 'string' ? (i.self.match(/^https?:\/\/[^/]+/)?.[0] ?? '') : ''
  const base = site || origin
  return {
    key: String(i.key ?? ''),
    summary: String(f.summary ?? ''),
    status: nameOf(f.status) || 'Unknown',
    category: categoryOf(f.status),
    type: nameOf(f.issuetype ?? f.issue_type ?? f.type),
    priority: nameOf(f.priority) || undefined,
    url: typeof i.url === 'string' ? i.url : base ? `${base}/browse/${i.key}` : undefined,
    parent: (f.parent?.key ?? i.parent?.key ?? undefined) as string | undefined,
    isSubtask: Boolean((f.issuetype ?? f.issue_type)?.subtask) || /sub/i.test(nameOf(f.issuetype ?? f.issue_type ?? f.type)),
  }
}

// A subtask whose parent is also in the list is drawn under it; any other issue is a top-level row.
function nest(tasks: Task[]): { top: Task[]; childrenOf: Map<string, Task[]> } {
  const keys = new Set(tasks.map(t => t.key))
  const childrenOf = new Map<string, Task[]>()
  const top: Task[] = []
  for (const t of tasks) {
    if (t.isSubtask && t.parent && keys.has(t.parent)) childrenOf.set(t.parent, [...(childrenOf.get(t.parent) ?? []), t])
    else top.push(t)
  }
  for (const list of childrenOf.values()) list.sort((a, b) => rank(a.status, a.category) - rank(b.status, b.category))
  return { top, childrenOf }
}

// One JQL search on whichever Jira server is connected; resolves (and remembers) the Atlassian site when the server needs one.
async function searchJira($: EngineInterface, jql: string, fields: string[], limit: number): Promise<{ tasks: Task[]; more: boolean; site: string }> {
  const { server, adapter } = await detect($)
  let cloudId = await read($, cloud)
  let site = await read($, siteUrl)
  if (adapter.needsCloudId && (!cloudId || !site)) {
    const found = await parse($, await $.mcp.call(server, 'getAccessibleAtlassianResources', {}))
    const first = found?.data?.resources?.[0] ?? found?.[0]
    cloudId = first?.cloudId ?? first?.id ?? ''
    site = site || (first?.url ?? '').replace(/\/$/, '')
    if (!cloudId) throw new Error('no Atlassian site found for this account')
    await update($, cloud, () => cloudId)
    await update($, siteUrl, () => site)
  }
  const issues: any[] = []
  let pageToken: string | undefined
  let cutOff = false
  do {
    const size = adapter.paged ? Math.min(PAGE_SIZE, limit - issues.length) : limit
    const res = await parse($, await $.mcp.call(server, adapter.tool, adapter.args(jql, cloudId, fields, size, pageToken)))
    issues.push(...listOf(res?.data?.issues ?? res?.issues ?? res))
    const last = res?.data?.isLast ?? true
    cutOff = adapter.paged ? res?.data?.isLast === false : issues.length >= limit
    pageToken = adapter.paged && !last && issues.length < limit ? res?.data?.nextPageToken : undefined
  } while (pageToken)
  return { tasks: issues.slice(0, limit).map(i => toTask(i, site)), more: cutOff, site }
}

function fetchTasks($: EngineInterface) {
  return searchJira($, JQL, TASK_FIELDS, 50)
}

// Your open GitHub PRs, from one `gh` search. PRs name their issue in the title (`AER-64: …`), so that's the match.
// Without gh, or signed out, there are simply no PRs.
async function fetchPullRequests($: EngineInterface): Promise<{ title: string; pr: PullRequest }[]> {
  try {
    const { exitCode, stdout } = await $.process.run(
      ['gh', 'search', 'prs', '--author=@me', '--state=open', '--limit=100', '--json=number,title,url,repository,isDraft'],
      { timeoutMs: 15000 },
    )
    if (exitCode !== 0) return []
    return (JSON.parse(stdout) as any[]).map(p => ({
      title: String(p.title ?? ''),
      pr: { repo: String(p.repository?.name ?? ''), number: Number(p.number), url: String(p.url), isDraft: Boolean(p.isDraft) },
    }))
  } catch {
    return []
  }
}

function attachPullRequests(tasks: Task[], prs: { title: string; pr: PullRequest }[]): Task[] {
  return tasks.map(t => {
    // KAN-1 must not match KAN-12.
    const mentions = new RegExp(`(^|[^A-Za-z0-9])${t.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i')
    const mine = prs.filter(p => mentions.test(p.title)).map(p => p.pr)
    return mine.length > 0 ? { ...t, prs: mine } : t
  })
}

// `  - PR [repo#19](url) draft` under the issue it belongs to.
function prLines(t: Task, indent: string): string[] {
  return (t.prs ?? []).map(p => `${indent}- PR [${p.repo}#${p.number}](${p.url}) ${p.isDraft ? 'draft' : 'open'}`)
}

// The row's text is plain markdown (what the transcript and the model see); the render hook below reads it
// back to draw the card, so every /jira row keeps its own snapshot.
function toMarkdown(tasks: Task[], at: Date, moreUrl?: string): string {
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const lines = [`Jira · ${tasks.length}${moreUrl ? '+' : ''} open · ${time}`]
  const { top, childrenOf } = nest(tasks)
  const link = (t: Task) => (t.url ? `[${t.key}](${t.url})` : t.key)
  for (const [status, list] of group(top)) {
    // `### QA (In Progress)`: the board's name, then the category when it says something the name doesn't.
    const category = list[0]!.category
    lines.push(category && category !== status ? `### ${status} (${category})` : `### ${status}`)
    for (const t of list) {
      // A subtask whose parent isn't listed names it: `(Subtask · in KAN-9)`.
      const orphanOf = t.isSubtask && t.parent ? ` · in ${t.parent}` : ''
      lines.push(`- ${link(t)} (${t.type || 'Task'}${orphanOf}) ${t.summary}`)
      lines.push(...prLines(t, '  '))
      // Nested subtasks carry their own status: `(Subtask · QA, In Progress)`.
      for (const c of childrenOf.get(t.key) ?? []) {
        const own = c.category && c.category !== c.status ? `${c.status}, ${c.category}` : c.status
        lines.push(`  - ${link(c)} (${c.type || 'Subtask'} · ${own}) ${c.summary}`)
        lines.push(...prLines(c, '    '))
      }
    }
  }
  if (moreUrl) lines.push(`[… more in Jira](<${moreUrl}>)`)
  return lines.join('\n')
}

type Row = {
  key: string
  url?: string
  type: string
  summary: string
  status: string
  category: Category
  depth: 0 | 1
  isLastChild?: boolean
  parent?: string
  prs: PullRequest[]
}

// Tolerates a prefix before the title (the transcript may show the plugin's name first).
function fromMarkdown(text: string): { count: string; time: string; rows: Row[]; moreUrl?: string } | undefined {
  const lines = text.split('\n')
  const head = lines[0]?.match(/Jira · (\d+\+?) open · (\S+)/)
  if (!head) return undefined
  const rows: Row[] = []
  let status = ''
  let category: Category = ''
  let moreUrl: string | undefined
  for (const line of lines.slice(1)) {
    const more = line.match(/^\[… more in Jira\]\(<(.+)>\)$/)
    if (more) {
      moreUrl = more[1]
      continue
    }
    if (line.startsWith('### ')) {
      const h = line.slice(4).match(/^(.*?)(?: \((To Do|In Progress|Done)\))?$/)!
      status = h[1]!
      category = (h[2] as Category | undefined) ?? (['To Do', 'In Progress', 'Done'].includes(status) ? (status as Category) : '')
    }
    else {
      const pr = line.match(/^\s*- PR \[([^\]]*)#(\d+)\]\(([^)]+)\) (open|draft)$/)
      if (pr) {
        rows[rows.length - 1]?.prs.push({ repo: pr[1]!, number: Number(pr[2]), url: pr[3]!, isDraft: pr[4] === 'draft' })
        continue
      }
      // `- [KAN-1](https://site/browse/KAN-1) (Task) Summary`, or a bare key without a site; indented for a subtask.
      const m = line.match(/^(\s*)- (?:\[([^\]]+)\]\(([^)]+)\)|(\S+)) \(([^)]*)\) (.*)$/)
      if (!m) continue
      const [type = '', ...extras] = m[5]!.split(' · ')
      const row: Row = { key: (m[2] ?? m[4])!, url: m[3], type, summary: m[6]!, status, category, depth: m[1] ? 1 : 0, prs: [] }
      for (const extra of extras) {
        if (extra.startsWith('in ')) row.parent = extra.slice(3)
        else {
          const [own = '', cat] = extra.split(', ')
          row.status = own
          row.category = (cat as Category | undefined) ?? (['To Do', 'In Progress', 'Done'].includes(own) ? (own as Category) : '')
        }
      }
      const prev = rows[rows.length - 1]
      if (row.depth === 1 && prev?.depth === 1) prev.isLastChild = false
      if (row.depth === 1) row.isLastChild = true
      rows.push(row)
    }
  }
  return { count: head[1]!, time: head[2]!, rows, moreUrl }
}

// The chip left of each row: the issue type's symbol and name on Jira's colour for it.
const TYPES = [
  { match: 'story', symbol: '▲', colour: 'green', label: 'Story' },
  { match: 'task', symbol: '●', colour: 'blue', label: 'Task' },
  { match: 'epic', symbol: '◆', colour: 'magenta', label: 'Epic' },
  { match: 'bug', symbol: '✖', colour: 'red', label: 'Bug' },
  { match: 'sub', symbol: '↳', colour: 'cyan', label: 'Subtask' },
]

function tileFor(type: string): { symbol: string; colour: string; label: string } {
  const t = type.toLowerCase()
  // Subtask before Task, since "subtask" contains "task".
  return TYPES.find(k => k.match === 'sub' && t.includes('sub')) ?? TYPES.find(k => t.includes(k.match)) ?? TYPES[1]!
}

// Terminals differ on clickable links (OSC 8), so the key is a button that asks the desktop to open the page.
async function openInBrowser($: EngineInterface, url: string) {
  for (const opener of ['xdg-open', 'open']) {
    try {
      const { exitCode } = await $.process.run([opener, url], { timeoutMs: 5000 })
      if (exitCode === 0) return
    } catch {
      // Not installed on this platform; try the next one.
    }
  }
  $.ui.toast(`Couldn't open ${url}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jira',
      description: 'Show your open Jira tasks in the chat',
    })
    return next(e)
  })

  on('command.run', { command: 'jira' }, async $ => {
    try {
      const [{ tasks, more, site }, prs] = await Promise.all([fetchTasks($), fetchPullRequests($)])
      const moreUrl = more && site ? `${site}/issues/?jql=${encodeURIComponent(JQL)}` : undefined
      return { text: toMarkdown(attachPullRequests(tasks, prs), new Date(), moreUrl) }
    } catch (err) {
      return { text: `Couldn't load Jira tasks: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'jira' } }, async ($, e, next) => {
    const card = fromMarkdown(e.props.text)
    if (!card) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const keyWidth = Math.max(0, ...card.rows.map(r => r.key.length))
    const statusWidth = Math.max(0, ...card.rows.map(r => r.status.length))
    // Chips share one width so keys line up: ` ▲ Story `, ` ● Task  `. Nested subtasks draw no chip.
    const chipWidth = Math.max(0, ...card.rows.filter(r => r.depth === 0).map(r => tileFor(r.type).label.length))
    const chip = 4 + chipWidth
    // As wide as the content needs (tile, key, summary, status, gaps), between 40 and 76 columns, never past the window.
    // `PR#19 +1`: the first PR and how many more, in its own column before the status.
    const prTag = (r: Row) => (r.prs.length === 0 ? '' : `PR#${r.prs[0]!.number}${r.prs.length > 1 ? ` +${r.prs.length - 1}` : ''}`)
    const prWidth = Math.max(0, ...card.rows.map(r => prTag(r).length))
    const prColumn = prWidth > 0 ? prWidth + 1 : 0
    // An orphan subtask ends with ` ↑ KAN-9`.
    const extra = (r: Row) => (r.parent ? r.parent.length + 3 : 0)
    const rowWidth = Math.max(0, ...card.rows.map(r => chip + 1 + keyWidth + 1 + r.summary.length + extra(r) + 2 + prColumn + statusWidth))
    const headWidth = 'Jira tasks'.length + 2 + `${card.count} open · ${card.time}`.length
    const width = Math.min(CARD_MAX, e.viewport?.columns ?? CARD_WIDTH)
    // What's left for the summary once the tile, key, status, gaps, border and padding are placed.
    const room = Math.max(8, width - 4 - (chip + 1 + keyWidth + 1 + 2 + prColumn + statusWidth))
    const fit = (r: Row) => {
      const space = Math.max(4, room - extra(r))
      return r.summary.length <= space ? r.summary : `${r.summary.slice(0, space - 1).trimEnd()}…`
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginTop={1} width={width}>
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text>{[...'Jira tasks'].map((ch, i) => <Text key={i} bold color={gradientColor(i, 'Jira tasks'.length)}>{ch}</Text>)}</Text>
          <Text dimColor>
            {card.count} open · {card.time}
          </Text>
        </Box>
        {card.rows.length === 0 && <Text dimColor>Nothing open is assigned to you.</Text>}
        {card.rows.map(r => {
          const tile = tileFor(r.type)
          return (
            <Box key={`row-${r.key}`} flexDirection="row" gap={1}>
              {r.depth === 1 ? (
                // A nested subtask: the tree line takes the chip's column, so its key lines up with the parent's.
                <Text color={tile.colour}>{`  ${r.isLastChild ? '└─' : '├─'} ↳`.padEnd(chip)}</Text>
              ) : (
                <Text backgroundColor={tile.colour} color="black" bold>
                  {` ${tile.symbol} ${tile.label.padEnd(chipWidth)} `}
                </Text>
              )}
              {r.url ? (
                <Box width={keyWidth} flexShrink={0}>
                  <Button key={`open-${r.key}`} plain label={r.key} hover={{ underline: true }} onPress={() => openInBrowser($, r.url!)} />
                </Box>
              ) : (
                <Text bold>{r.key.padEnd(keyWidth)}</Text>
              )}
              <Box flexGrow={1}>
                <Text wrap="truncate">
                  {fit(r)}
                  {r.parent && <Text dimColor> ↑ {r.parent}</Text>}
                </Text>
              </Box>
              {prWidth > 0 && (
                <Box width={prWidth}>
                  {r.prs.length > 0 && (
                    <Box flexDirection="row">
                      <Button
                        key={`pr-${r.key}`}
                        plain
                        dimColor={r.prs[0]!.isDraft}
                        label={`PR#${r.prs[0]!.number}`}
                        hover={{ underline: true }}
                        onPress={() => openInBrowser($, r.prs[0]!.url)}
                      />
                      {r.prs.length > 1 && <Text dimColor> +{r.prs.length - 1}</Text>}
                    </Box>
                  )}
                </Box>
              )}
              <Text color={colourFor(r.status, r.category)}>{r.status.padEnd(statusWidth)}</Text>
            </Box>
          )
        })}
        {card.moreUrl && (
          <Box key="more" marginTop={1}>
            <Button key="open-more" plain dimColor label="… more in Jira →" hover={{ underline: true }} onPress={() => openInBrowser($, card.moreUrl!)} />
          </Box>
        )}
      </Box>
    )
  })
}
