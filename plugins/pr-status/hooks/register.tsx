import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const CARD_WIDTH = 100

const cloud = atom({ plugin: 'pr-status', key: 'cloudId' } as const, '')
const siteUrl = atom({ plugin: 'pr-status', key: 'site' } as const, '')

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

// Search tools of known Jira MCP servers, and the arguments each takes. A server is recognised by the tool it
// offers, not its name, so a company build of either server is picked up too; failing both, any MCP tool named
// like a Jira search (`jira_search_issues`, `searchJira`) is tried with just `{ jql }`.
type Adapter = { tool: string; args: (jql: string, cloudId: string, fields: string[], limit: number) => Record<string, unknown>; needsCloudId: boolean }
const ADAPTERS: Adapter[] = [
  // Atlassian's own remote MCP (the `atlassian` plugin).
  {
    tool: 'searchJiraIssuesUsingJql',
    needsCloudId: true,
    args: (jql, cloudId, fields, limit) => ({ cloudId, jql, fields, maxResults: limit, view: 'full' }),
  },
  // sooperset/mcp-atlassian, common for self-hosted Jira Server / Data Center.
  { tool: 'jira_search', needsCloudId: false, args: (jql, _cloudId, fields, limit) => ({ jql, fields: fields.join(','), limit }) },
]


type Source = { server: string; adapter: Adapter }

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

// MCP servers answer with a text block holding JSON.
function parse(result: { content: { type: string; text?: string }[]; isError: boolean }): any {
  const text = result.content.find(block => block.type === 'text')?.text ?? ''
  if (result.isError) throw new Error(text || 'the Jira server reported an error')
  return JSON.parse(text)
}
const nameOf = (v: any): string => (typeof v === 'string' ? v : (v?.name ?? ''))

// What the status lookup needs of an issue. Reads both shapes: Jira's REST issue (`fields.status.name`) and flattened ones.
type Issue = { key: string; status: string; category: Category; url?: string }

const originOf = (url: unknown): string => (typeof url === 'string' ? (url.match(/^https?:\/\/[^/]+/)?.[0] ?? '') : '')

function toIssue(i: any, site: string): Issue {
  const f = i.fields ?? i
  const base = site || originOf(i.self)
  return {
    key: String(i.key ?? ''),
    status: nameOf(f.status) || 'Unknown',
    category: categoryOf(f.status),
    url: typeof i.url === 'string' ? i.url : base ? `${base}/browse/${i.key}` : undefined,
  }
}

// One JQL search on whichever Jira server is connected. Remembers the Atlassian site: from the server's resource list
// when it needs one, else from the issues themselves, so the keys on the card can link with any server.
async function searchJira($: EngineInterface, jql: string, fields: string[], limit: number): Promise<Issue[]> {
  const { server, adapter } = await detect($)
  let cloudId = await read($, cloud)
  let site = await read($, siteUrl)
  if (adapter.needsCloudId && (!cloudId || !site)) {
    const found = parse(await $.mcp.call(server, 'getAccessibleAtlassianResources', {}))
    const first = found?.data?.resources?.[0] ?? found?.[0]
    cloudId = first?.cloudId ?? first?.id ?? ''
    site = site || (first?.url ?? '').replace(/\/$/, '')
    if (!cloudId) throw new Error('no Atlassian site found for this account')
    await update($, cloud, () => cloudId)
    await update($, siteUrl, () => site)
  }
  const res = parse(await $.mcp.call(server, adapter.tool, adapter.args(jql, cloudId, fields, limit)))
  const raw: any[] = res?.data?.issues ?? res?.issues ?? (Array.isArray(res) ? res : [])
  const issues = raw.map(i => toIssue(i, site))
  if (!site) {
    const found = originOf(raw.find(i => typeof i.url === 'string')?.url) || originOf(raw.find(i => typeof i.self === 'string')?.self)
    if (found) await update($, siteUrl, () => found)
  }
  return issues
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

// One GraphQL call: your open PRs and the ones waiting on your review, each with its review decision and the
// last commit's combined CI state. Your own PRs also carry their review threads, to count what is still open.
const PR_QUERY = `query {
  viewer { login }
  mine: search(query: "is:pr is:open author:@me archived:false sort:updated-desc", type: ISSUE, first: 50) { nodes { ...pr ...threads } }
  review: search(query: "is:pr is:open review-requested:@me archived:false sort:updated-desc", type: ISSUE, first: 50) { nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft reviewDecision headRefName baseRefName mergeable
  repository { name defaultBranchRef { name } }
  author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes { __typename ... on CheckRun { name conclusion } ... on StatusContext { context state } } } } } } }
}
fragment threads on PullRequest {
  reviewThreads(first: 100) { nodes { isResolved comments(last: 1) { nodes { author { login } } } } }
}`

type Review = 'Approved' | 'Changes' | 'Review' | 'Draft'
type Ci = 'passing' | 'failing' | 'running' | ''
// `waiting`: unresolved threads whose last comment is someone else's, so the next move is yours.
type Threads = { resolved: number; total: number; waiting: number }
// `conflict` and `failing` are only known for your own PRs; `jira` only when the Jira lookup answered.
type JiraStatus = { status: string; category: Category }
type PrRow = {
  repo: string; number: number; url: string; title: string; review: Review; ci: Ci
  key?: string; author?: string; threads?: Threads; conflict?: boolean; failing?: string[]; jira?: JiraStatus
  // Stacked PRs (yours only): `depth` under the PR it is based on (`onPr`), or, when that PR isn't listed, the base branch.
  depth?: number; onPr?: number; onBranch?: string
}
type PrBoard = { mine: PrRow[]; review: PrRow[] }

const JIRA_TIMEOUT_MS = 4000
const FAILED_RUNS = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

const ISSUE_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/

function threadsOf(n: any, me: string): Threads | undefined {
  const list: any[] = n.reviewThreads?.nodes ?? []
  if (list.length === 0) return undefined
  const open = list.filter(t => !t.isResolved)
  const waiting = open.filter(t => {
    const last = t.comments?.nodes?.[0]?.author?.login
    return last && last !== me
  }).length
  return { resolved: list.length - open.length, total: list.length, waiting }
}

// Names of the checks that failed on the last commit, once each, in the order GitHub lists them. Names travel in
// the markdown line, so the separators it uses are swapped out.
function failingChecks(n: any): string[] {
  const nodes: any[] = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  const names = nodes
    .filter(c => (c?.__typename === 'CheckRun' ? FAILED_RUNS.includes(c.conclusion) : c?.state === 'FAILURE' || c?.state === 'ERROR'))
    .map(c => String(c.name ?? c.context ?? '').replace(/,/g, ';').replace(/ · /g, ' - ').trim())
    .filter(Boolean)
  return [...new Set(names)]
}

function toPrRow(n: any, withAuthor: boolean, me = ''): PrRow {
  const rollup = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state as string | undefined
  const ci: Ci =
    rollup === 'SUCCESS' ? 'passing' : rollup === 'FAILURE' || rollup === 'ERROR' ? 'failing' : rollup ? 'running' : ''
  const review: Review = n.isDraft
    ? 'Draft'
    : n.reviewDecision === 'APPROVED'
      ? 'Approved'
      : n.reviewDecision === 'CHANGES_REQUESTED'
        ? 'Changes'
        : 'Review'
  return {
    repo: String(n.repository?.name ?? ''),
    number: Number(n.number),
    url: String(n.url),
    title: String(n.title ?? ''),
    review,
    ci,
    // The issue key from the title, else the branch (`feature/AER-64`).
    key: (String(n.title ?? '').match(ISSUE_KEY) ?? String(n.headRefName ?? '').match(ISSUE_KEY))?.[0],
    author: withAuthor ? n.author?.login : undefined,
    threads: withAuthor ? undefined : threadsOf(n, me),
    conflict: !withAuthor && n.mergeable === 'CONFLICTING' ? true : undefined,
    failing: withAuthor ? undefined : failingChecks(n),
  }
}

// Your PRs whose base isn't the repo's default branch are stacked. One whose base is another of your PRs' head branch
// in the same repo goes under it, to any depth, children in their original order; the rest stay top-level rows and
// name their base branch. Branch names travel in the markdown line, so the separators it uses are swapped out.
function stackPrs(nodes: any[], rows: PrRow[]): PrRow[] {
  const base = nodes.map(n => String(n.baseRefName ?? ''))
  const stacked = nodes.map((n, i) => Boolean(base[i]) && Boolean(n.repository?.defaultBranchRef?.name) && base[i] !== n.repository.defaultBranchRef.name)
  const parentOf = nodes.map((n, i) =>
    stacked[i] ? nodes.findIndex((o, j) => j !== i && rows[j]!.repo === rows[i]!.repo && o.headRefName === base[i]) : -1,
  )
  const children = new Map<number, number[]>()
  parentOf.forEach((p, i) => p >= 0 && children.set(p, [...(children.get(p) ?? []), i]))
  const out: PrRow[] = []
  const seen = new Set<number>()
  const emit = (i: number, depth: number) => {
    if (seen.has(i)) return
    seen.add(i)
    const row = rows[i]!
    if (depth > 0) row.depth = depth
    if (parentOf[i]! >= 0) row.onPr = rows[parentOf[i]!]!.number
    else if (stacked[i]) row.onBranch = base[i]!.replace(/ · /g, ' - ').replace(/[()]/g, '')
    out.push(row)
    for (const c of children.get(i) ?? []) emit(c, depth + 1)
  }
  rows.forEach((_, i) => parentOf[i]! < 0 && emit(i, 0))
  // Only a cycle of branches is left unplaced; show those as top-level rows.
  rows.forEach((_, i) => emit(i, 0))
  return out
}

async function fetchPrBoard($: EngineInterface): Promise<PrBoard> {
  const { exitCode, stdout, stderr } = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${PR_QUERY}`], {
    timeoutMs: 20000,
  })
  if (exitCode !== 0) throw new Error((stderr || stdout).trim().split('\n')[0] || `gh exited with ${exitCode}`)
  const data = JSON.parse(stdout)?.data
  const nodes = (k: string) => (data?.[k]?.nodes ?? []).filter((n: any) => n && n.number)
  const me = String(data?.viewer?.login ?? '')
  const mineNodes: any[] = nodes('mine')
  const mine = stackPrs(mineNodes, mineNodes.map(n => toPrRow(n, false, me)))
  return { mine, review: nodes('review').map((n: any) => toPrRow(n, true)) }
}

// `- [web#7544](url) (Approved · conflict · CI failing · failing: build, lint · 3/4 threads resolved · 1 waiting on
// you · INT-352 · jira: In Review/In Progress) Title`: readable for the model, read back to draw. The jira fact is
// `<status>/<category>`; the category (To Do, In Progress, Done or empty) never holds a slash, so the last one splits.
// Rejects when `work` hasn't settled in `ms`. Takes `$` for its timer, which is cancelled once the work is over.
function withTimeout<T>($: EngineInterface, work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = $.clock.after(ms, () => reject(new Error('timed out')))
    work.then(
      v => {
        timer.cancel()
        resolve(v)
      },
      e => {
        timer.cancel()
        reject(e)
      },
    )
  })
}

// Puts each row's Jira status on it, from one search for all their keys (Done included, unlike /jira). Keys the
// server doesn't return stay bare. Resolves true when Jira could not be asked or didn't answer in time; with no keys
// there is nothing to ask and nothing to report.
async function addJiraStatuses($: EngineInterface, board: PrBoard): Promise<boolean> {
  const rows = [...board.mine, ...board.review]
  const keys = [...new Set(rows.map(r => r.key).filter((k): k is string => Boolean(k)))]
  if (keys.length === 0) return false
  try {
    const issues = await withTimeout($, searchJira($, `key in (${keys.join(', ')})`, ['summary', 'status'], Math.max(50, keys.length)), JIRA_TIMEOUT_MS)
    const byKey = new Map(issues.map(i => [i.key, i]))
    for (const r of rows) {
      const issue = r.key ? byKey.get(r.key) : undefined
      if (issue) r.jira = { status: issue.status, category: issue.category }
    }
    return false
  } catch {
    return true
  }
}

function prBoardToMarkdown(board: PrBoard, at: Date, jiraDown = false): string {
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const line = (r: PrRow) => {
    const t = r.threads
    const facts = [
      r.review,
      r.conflict ? 'conflict' : '',
      r.ci ? `CI ${r.ci}` : '',
      r.failing?.length ? `failing: ${r.failing.join(', ')}` : '',
      t ? `${t.resolved}/${t.total} threads resolved` : '',
      t?.waiting ? `${t.waiting} waiting on you` : '',
      r.onPr ? `on #${r.onPr}` : r.onBranch ? `on ${r.onBranch}` : '',
      r.key ?? '',
      r.jira ? `jira: ${r.jira.status.replace(/ · /g, ' - ')}/${r.jira.category}` : '',
      r.author ? `by ${r.author}` : '',
    ].filter(Boolean)
    // Stacked PRs are indented two spaces per level, right after the PR they sit on, like /jira subtasks.
    return `${'  '.repeat(r.depth ?? 0)}- [${r.repo}#${r.number}](${r.url}) (${facts.join(' · ')}) ${r.title}`
  }
  const lines = [`PRs · ${board.mine.length} mine · ${board.review.length} to review · ${time}${jiraDown ? ' · Jira unavailable' : ''}`]
  if (board.mine.length > 0) lines.push('### Mine', ...board.mine.map(line))
  if (board.review.length > 0) lines.push('### Waiting on you', ...board.review.map(line))
  return lines.join('\n')
}

function prBoardFromMarkdown(text: string): { head: string; jiraDown: boolean; sections: [string, PrRow[]][] } | undefined {
  const lines = text.split('\n')
  const head = lines[0]?.match(/PRs · (\d+ mine · \d+ to review · \S+)( · Jira unavailable)?/)
  if (!head) return undefined
  const sections: [string, PrRow[]][] = []
  for (const l of lines.slice(1)) {
    if (l.startsWith('### ')) {
      sections.push([l.slice(4), []])
      continue
    }
    const m = l.match(/^( *)- \[([^\]]*)#(\d+)\]\(([^)]+)\) \(([^)]*)\) (.*)$/)
    if (!m || sections.length === 0) continue
    const row: PrRow = { repo: m[2]!, number: Number(m[3]), url: m[4]!, title: m[6]!, review: 'Review', ci: '' }
    if (m[1]) row.depth = Math.floor(m[1].length / 2)
    for (const fact of m[5]!.split(' · ')) {
      if (['Approved', 'Changes', 'Review', 'Draft'].includes(fact)) row.review = fact as Review
      else if (fact === 'conflict') row.conflict = true
      else if (fact.startsWith('CI ')) row.ci = fact.slice(3) as Ci
      else if (fact.startsWith('failing: ')) row.failing = fact.slice(9).split(', ')
      else if (fact.startsWith('jira: ')) {
        const text = fact.slice(6)
        const cut = text.lastIndexOf('/')
        row.jira = { status: text.slice(0, cut), category: text.slice(cut + 1) as Category }
      } else if (fact.startsWith('by ')) row.author = fact.slice(3)
      else if (/^\d+\/\d+ threads resolved$/.test(fact)) {
        const [resolved, total] = fact.split(' ')[0]!.split('/').map(Number)
        row.threads = { resolved: resolved!, total: total!, waiting: row.threads?.waiting ?? 0 }
      } else if (/^\d+ waiting on you$/.test(fact) && row.threads) row.threads.waiting = parseInt(fact, 10)
      else if (/^on #\d+$/.test(fact)) row.onPr = parseInt(fact.slice(4), 10)
      else if (fact.startsWith('on ')) row.onBranch = fact.slice(3)
      else if (ISSUE_KEY.test(fact)) row.key = fact
    }
    sections[sections.length - 1]![1].push(row)
  }
  return { head: head[1]!, jiraDown: Boolean(head[2]), sections }
}

const REVIEW_COLOUR: Record<Review, string> = { Approved: 'green', Changes: 'red', Review: 'yellow', Draft: 'gray' }
const CI_MARK: Record<Ci, { mark: string; colour: string }> = {
  passing: { mark: '✓', colour: 'green' },
  failing: { mark: '✗', colour: 'red' },
  running: { mark: '●', colour: 'yellow' },
  '': { mark: ' ', colour: 'gray' },
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pr',
      description: 'Show your open PRs and the ones waiting on your review, with review and CI state',
    })
    return next(e)
  })

  on('command.run', { command: 'pr' }, async $ => {
    try {
      const board = await fetchPrBoard($)
      const jiraDown = await addJiraStatuses($, board)
      return { text: prBoardToMarkdown(board, new Date(), jiraDown) }
    } catch (err) {
      return { text: `Couldn't load PRs: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'pr' } }, async ($, e, next) => {
    const board = prBoardFromMarkdown(e.props.text)
    if (!board) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const site = await read($, siteUrl)
    const rows = board.sections.flatMap(([, list]) => list)
    // Terminal cell width: `⚠` is drawn 2 wide by some terminals, so count it as 2.
    const cells = (text: string) => text.length + (text.match(/⚠/g)?.length ?? 0)
    const numWidth = Math.max(0, ...rows.map(r => `PR#${r.number}`.length))
    const repoWidth = Math.min(18, Math.max(0, ...rows.map(r => r.repo.length)))
    const keyWidth = Math.max(0, ...rows.map(r => r.key?.length ?? 0))
    // The Jira status sits after the key, in the same column; long board names are cut.
    const jiraCut = (status: string) => (status.length <= 16 ? status : `${status.slice(0, 15).trimEnd()}…`)
    const statusWidth = Math.max(0, ...rows.map(r => (r.jira ? jiraCut(r.jira.status).length : 0)))
    const keyColumn = keyWidth + (statusWidth ? statusWidth + 1 : 0)
    const reviewWidth = Math.max(0, ...rows.map(r => r.review.length))
    const conflictMark = '⚠ conflict'
    const fraction = (t: Threads) => `${t.resolved}/${t.total}`
    const waitingMark = (t: Threads) => (t.waiting ? ` ●${t.waiting}` : '')
    // One signals column (threads, conflict, CI) as wide as the busiest row, right-aligned against the review label;
    // its parts are two spaces apart. No row with a signal, no column.
    const signalLength = (r: PrRow) => {
      const parts = [r.threads ? fraction(r.threads).length + waitingMark(r.threads).length : 0, r.conflict ? cells(conflictMark) : 0, r.ci ? 1 : 0].filter(Boolean)
      return parts.reduce((sum, n) => sum + n, 0) + 2 * Math.max(0, parts.length - 1)
    }
    const signalsWidth = Math.max(0, ...rows.map(signalLength)) + (rows.some(r => r.conflict) ? 2 : 0)
    // A stacked PR whose base isn't listed ends with ` on feature/x`.
    // A stacked PR's tree glyph leads its title (`└─ `, `├─ ` when a sibling follows), three cells deeper per level.
    const treeOf = (list: PrRow[], i: number) => {
      const r = list[i]!
      if (!r.depth) return ''
      const rest = list.slice(i + 1)
      const end = rest.findIndex(o => (o.depth ?? 0) < (r.depth ?? 0))
      const last = !rest.slice(0, end < 0 ? rest.length : end).some(o => o.depth === r.depth)
      return `${'   '.repeat(r.depth - 1)}${last ? '└─' : '├─'} `
    }
    const prefixes = new Map(board.sections.flatMap(([, list]) => list.map((r, i) => [r, treeOf(list, i)] as const)))
    const suffix = (r: PrRow) => (r.author ? ` · ${r.author}` : r.onBranch ? ` on ${r.onBranch}` : '')
    const columns = 4 + (keyColumn ? 1 : 0) + (signalsWidth ? 1 : 0)
    const fixed = numWidth + repoWidth + keyColumn + signalsWidth + reviewWidth + (columns - 1)
    // Same fixed width as the other card (/jira and /pr), so they line up; narrower only on a narrow window.
    const width = Math.min(CARD_WIDTH, e.viewport?.columns ?? CARD_WIDTH)
    const room = Math.max(8, width - 4 - fixed - 1)
    // The failing-checks line starts under the title column.
    const indent = numWidth + 1 + repoWidth + 1
    const cut = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, n - 1).trimEnd()}…`)

    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1} width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Pull requests</Text>
          <Text dimColor>{board.head + (board.jiraDown ? ' · Jira unavailable' : '')}</Text>
        </Box>
        {rows.length === 0 && <Text dimColor>No open PRs, and nothing waiting on your review.</Text>}
        {board.sections.map(([name, list]) => (
          <Box key={`s-${name}`} flexDirection="column" marginTop={1}>
            <Text bold dimColor>
              {name}
            </Text>
            {list.map((r, i) => {
              const ci = CI_MARK[r.ci]
              const tree = prefixes.get(r) ?? ''
              // An open PR on a Done ticket is a mismatch worth noticing.
              const mismatch = name === 'Mine' && r.jira?.category === 'Done'
              return (
                <Box key={`pr-${r.repo}-${r.number}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Box width={numWidth} flexShrink={0} flexDirection="row">
                      <Button
                        key={`open-${r.repo}-${r.number}`}
                        plain
                        dimColor={r.review === 'Draft'}
                        label={`PR#${r.number}`}
                        hover={{ underline: true }}
                        onPress={() => openInBrowser($, r.url)}
                      />
                    </Box>
                    <Box width={repoWidth} flexShrink={0}>
                      <Text dimColor wrap="truncate">{cut(r.repo, repoWidth).padEnd(repoWidth)}</Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text wrap="truncate">
                        {tree && <Text dimColor>{tree}</Text>}
                        {cut(r.title, Math.max(4, room - tree.length - suffix(r).length))}
                        {r.author && <Text dimColor> · {r.author}</Text>}
                        {r.onBranch && <Text dimColor> on {r.onBranch}</Text>}
                      </Text>
                    </Box>
                    {keyColumn > 0 && (
                      <Box width={keyColumn} flexShrink={0} gap={1}>
                        <Box width={keyWidth}>
                          {r.key && site ? (
                            <Button
                              key={`key-${r.repo}-${r.number}`}
                              plain
                              label={r.key}
                              hover={{ underline: true }}
                              onPress={() => openInBrowser($, `${site}/browse/${r.key}`)}
                            />
                          ) : (
                            <Text>{r.key ?? ''}</Text>
                          )}
                        </Box>
                        {r.jira && (
                          <Text bold={mismatch} color={mismatch ? 'red' : colourFor(r.jira.status, r.jira.category)}>
                            {jiraCut(r.jira.status)}
                          </Text>
                        )}
                      </Box>
                    )}
                    {signalsWidth > 0 && (
                      <Box width={signalsWidth} flexShrink={0} flexDirection="row" justifyContent="flex-end" gap={2}>
                        {r.threads && (
                          <Text>
                            <Text color={r.threads.resolved < r.threads.total ? 'yellow' : 'gray'}>{fraction(r.threads)}</Text>
                            {r.threads.waiting > 0 && <Text color="red">{waitingMark(r.threads)}</Text>}
                          </Text>
                        )}
                        {r.conflict && (
                          <Box flexShrink={0}>
                            <Text color="red">{conflictMark}</Text>
                          </Box>
                        )}
                        {r.ci && <Text color={ci.colour}>{ci.mark}</Text>}
                      </Box>
                    )}
                    <Box width={reviewWidth} flexShrink={0}>
                      <Text color={REVIEW_COLOUR[r.review]} wrap="truncate">{r.review.padStart(reviewWidth)}</Text>
                    </Box>
                  </Box>
                  {r.failing && r.failing.length > 0 && (
                    <Box paddingLeft={indent}>
                      <Text color="red" dimColor wrap="truncate">
                        {cut(`✗ ${r.failing.join(' · ')}`, Math.max(8, width - 4 - indent))}
                      </Text>
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  })
}
