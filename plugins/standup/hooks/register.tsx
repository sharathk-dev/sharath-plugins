import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { draftOf, fromText, isEmpty, jiraJql, parseArgs, toText, totalCommits, windowFor } from './standup'
import type { CommitRepo, JiraItem, PrItem, Report, Win } from './standup'

const CARD_WIDTH = 100

const cloud = atom({ plugin: 'standup', key: 'cloudId' } as const, '')
const siteUrl = atom({ plugin: 'standup', key: 'site' } as const, '')

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


const originOf = (url: unknown): string => (typeof url === 'string' ? (url.match(/^https?:\/\/[^/]+/)?.[0] ?? '') : '')

type Issue = { key: string; summary: string; updated: number; status: string; category: Category; url?: string }

function toIssue(i: any, site: string): Issue {
  const f = i.fields ?? i
  const base = site || originOf(i.self)
  return {
    key: String(i.key ?? ''),
    summary: String(f.summary ?? ''),
    updated: Date.parse(String(f.updated ?? '')) || 0,
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

const JIRA_TIMEOUT_MS = 4000
const MAX_COMMIT_REPOS = 5

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

// Round trip 1: commit counts per repo, PRs opened and reviewed (the contributions collection) and PRs merged
// (a search; the collection has no merged event). Round trip 2 (only when something was committed) asks the
// default branch of up to five repos for the commit headlines.
const ACTIVITY_QUERY = `query($from: DateTime!, $to: DateTime!, $merged: String!) {
  viewer {
    id login
    pullRequests(states: OPEN, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { headRefName updatedAt repository { nameWithOwner } } }
    contributionsCollection(from: $from, to: $to) {
      commitContributionsByRepository(maxRepositories: 10) { repository { nameWithOwner } contributions { totalCount } }
      pullRequestContributions(first: 30) { nodes { pullRequest { number title url createdAt headRefName repository { nameWithOwner } } } }
      pullRequestReviewContributions(first: 30) { nodes { occurredAt pullRequest { number title url repository { nameWithOwner } } } }
    }
  }
  merged: search(query: $merged, type: ISSUE, first: 30) { nodes { ... on PullRequest { number title url mergedAt repository { nameWithOwner } } } }
}`

const HISTORY = 'history(since: $since, until: $until, author: {id: $author}, first: 5) { nodes { oid messageHeadline committedDate } }'
const MAX_BRANCHES_PER_REPO = 4

function messagesQuery(branches: string[][]): string {
  const decl = branches.flatMap((list, i) => [`$o${i}: String!`, `$n${i}: String!`, ...list.map((_, j) => `$b${i}_${j}: String!`)]).join(', ')
  const body = branches.flatMap((list, i) => [
    `  r${i}: repository(owner: $o${i}, name: $n${i}) { defaultBranchRef { target { ... on Commit { ${HISTORY} } } } }`,
    ...list.map((_, j) => `  b${i}_${j}: repository(owner: $o${i}, name: $n${i}) { ref(qualifiedName: $b${i}_${j}) { target { ... on Commit { ${HISTORY} } } } }`),
  ])
  return `query($since: GitTimestamp!, $until: GitTimestamp!, $author: ID!, ${decl}) {\n${body.join('\n')}\n}`
}

async function graphql($: EngineInterface, query: string, vars: Record<string, string>): Promise<any> {
  const argv = ['gh', 'api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(vars)) argv.push('-f', `${k}=${v}`)
  const { exitCode, stdout, stderr } = await $.process.run(argv, { timeoutMs: 20000 })
  if (exitCode !== 0) throw new Error((stderr || stdout).trim().split('\n')[0] || `gh exited with ${exitCode}`)
  const parsed = JSON.parse(stdout)
  if (parsed?.errors?.length && !parsed.data) throw new Error(String(parsed.errors[0]?.message ?? 'GraphQL error'))
  return parsed.data
}

type GitHub = { commits: CommitRepo[]; prs: PrItem[] }

const shortRepo = (nameWithOwner: string) => nameWithOwner.split('/').pop() ?? nameWithOwner

async function fetchGitHub($: EngineInterface, w: Win): Promise<GitHub> {
  const from = w.from.toISOString()
  const to = w.to.toISOString()
  const data = await graphql($, ACTIVITY_QUERY, { from, to, merged: `is:pr author:@me merged:${from}..${to}` })
  const cc = data?.viewer?.contributionsCollection

  const stamped: { at: number; item: PrItem }[] = []
  const add = (kind: PrItem['kind'], n: any, at: unknown) => {
    if (!n?.number) return
    stamped.push({
      at: Date.parse(String(at ?? '')) || 0,
      item: { kind, repo: shortRepo(String(n.repository?.nameWithOwner ?? '')), number: Number(n.number), url: String(n.url), title: String(n.title ?? '') },
    })
  }
  for (const n of data?.merged?.nodes ?? []) add('merged', n, n?.mergedAt)
  const mergedUrls = new Set(stamped.map(p => p.item.url))
  for (const c of cc?.pullRequestContributions?.nodes ?? []) if (!mergedUrls.has(c?.pullRequest?.url)) add('opened', c?.pullRequest, c?.pullRequest?.createdAt)
  for (const c of cc?.pullRequestReviewContributions?.nodes ?? []) add('reviewed', c?.pullRequest, c?.occurredAt)
  stamped.sort((a, b) => b.at - a.at)
  const seen = new Set<string>()
  const prs = stamped.map(p => p.item).filter(p => {
    const id = `${p.kind}:${p.url}`
    return seen.has(id) ? false : (seen.add(id), true)
  })

  const commits: (CommitRepo & { full: string; latest: number })[] = (cc?.commitContributionsByRepository ?? [])
    .map((r: any) => ({ full: String(r.repository?.nameWithOwner ?? ''), repo: shortRepo(String(r.repository?.nameWithOwner ?? '')), count: Number(r.contributions?.totalCount ?? 0), messages: [] as string[], latest: 0 }))
    .filter((r: CommitRepo) => r.count > 0)
    .sort((a: CommitRepo, b: CommitRepo) => b.count - a.count)

  const branchesOf = (full: string): string[] => {
    const names = new Set<string>()
    const take = (pr: any) => {
      if (pr?.headRefName && pr.repository?.nameWithOwner === full) names.add(String(pr.headRefName))
    }
    for (const pr of data?.viewer?.pullRequests?.nodes ?? []) if ((Date.parse(String(pr?.updatedAt)) || 0) >= w.from.getTime()) take(pr)
    for (const c of cc?.pullRequestContributions?.nodes ?? []) take({ ...c?.pullRequest, repository: c?.pullRequest?.repository })
    return [...names].slice(0, MAX_BRANCHES_PER_REPO)
  }

  const top = commits.slice(0, MAX_COMMIT_REPOS)
  if (top.length > 0 && data?.viewer?.id) {
    try {
      const branches = top.map(r => branchesOf(r.full))
      const vars: Record<string, string> = { since: from, until: to, author: String(data.viewer.id) }
      top.forEach((r, i) => {
        vars[`o${i}`] = r.full.split('/')[0] ?? ''
        vars[`n${i}`] = r.full.split('/')[1] ?? ''
        branches[i]!.forEach((name, j) => (vars[`b${i}_${j}`] = `refs/heads/${name}`))
      })
      const msgs = await graphql($, messagesQuery(branches), vars)
      top.forEach((r, i) => {
        const histories = [msgs?.[`r${i}`]?.defaultBranchRef, ...branches[i]!.map((_, j) => msgs?.[`b${i}_${j}`]?.ref)]
        const byOid = new Map<string, any>()
        for (const h of histories) for (const n of h?.target?.history?.nodes ?? []) byOid.set(String(n.oid ?? `${n.committedDate}${n.messageHeadline}`), n)
        const newestFirst = [...byOid.values()].sort((a, b) => (Date.parse(String(b.committedDate)) || 0) - (Date.parse(String(a.committedDate)) || 0))
        const headlines = newestFirst.map(n => String(n.messageHeadline ?? '')).filter(Boolean)
        r.count = Math.max(r.count, headlines.length)
        r.messages = headlines.slice(0, 5)
        r.latest = Date.parse(String(newestFirst[0]?.committedDate ?? '')) || 0
      })
    } catch {
      // The headlines are optional: the card keeps the counts.
    }
  }
  commits.sort((a, b) => b.latest - a.latest)
  return { commits: commits.map(({ full: _full, latest: _latest, ...rest }) => rest), prs }
}

// Jira tickets whose status changed in the window. Resolves null when Jira could not be asked or did not answer in time.
async function fetchJira($: EngineInterface, w: Win): Promise<JiraItem[] | null> {
  try {
    const issues = await withTimeout($, searchJira($, jiraJql(w), ['summary', 'status', 'updated'], 50), JIRA_TIMEOUT_MS)
    const site = await read($, siteUrl)
    return [...issues].sort((a, b) => b.updated - a.updated).map(i => ({ key: i.key, url: i.url ?? (site ? `${site}/browse/${i.key}` : ''), summary: i.summary, status: i.status, category: i.category }))
  } catch {
    return null
  }
}

const ISSUE_STATUS_COLOUR = colourFor

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'standup',
      description: 'Show what you did since yesterday: commits, PRs and Jira tickets (also: yesterday, today, 3d)',
    })
    return next(e)
  })

  on('command.run', { command: 'standup' }, async ($, e) => {
    const spec = parseArgs(e.args)
    if ('error' in spec) return { text: spec.error }
    const w = windowFor(new Date(await $.clock.now()), spec)
    try {
      const [gh, jira] = await Promise.all([fetchGitHub($, w), fetchJira($, w)])
      const report: Report = { label: w.label, word: w.word, jiraDown: jira === null, commits: gh.commits, prs: gh.prs, jira: jira ?? [] }
      return { text: toText(report) }
    } catch (err) {
      return { text: `Couldn't load standup: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'standup' } }, async ($, e, next) => {
    const report = fromText(e.props.text)
    if (!report) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.min(CARD_WIDTH, e.viewport?.columns ?? CARD_WIDTH)
    const inner = width - 4
    const cut = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, Math.max(1, n - 1)).trimEnd()}…`)
    const repoWidth = Math.min(18, Math.max(0, ...report.commits.map(c => c.repo.length), ...report.prs.map(p => p.repo.length)))
    const empty = isEmpty(report)
    const commitCount = totalCommits(report)

    const MARK: Record<string, { mark: string; colour: string }> = {
      merged: { mark: '✓ merged', colour: 'magenta' },
      opened: { mark: '↑ opened', colour: 'green' },
      reviewed: { mark: '◎ reviewed', colour: 'cyan' },
    }
    const kindWidth = Math.max(0, ...report.prs.map(p => MARK[p.kind]!.mark.length))
    const numWidth = Math.max(0, ...report.prs.map(p => `#${p.number}`.length))
    const keyWidth = Math.max(0, ...report.jira.map(j => j.key.length))
    const statusCut = (s: string) => (s.length <= 16 ? s : `${s.slice(0, 15).trimEnd()}…`)
    const statusWidth = Math.max(0, ...report.jira.map(j => statusCut(j.status).length + 2))

    const commitText = (c: { count: number; messages: string[] }) => {
      if (c.messages.length === 0) return `${c.count} commit${c.count === 1 ? '' : 's'}`
      const shown = c.messages.slice(0, 2)
      const more = c.count - shown.length
      return [...shown, ...(more > 0 ? [`+${more} more`] : [])].join(' · ')
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1} width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{empty ? `Nothing found for ${report.label}` : `Standup · ${report.label}`}</Text>
          <Text dimColor>{report.jiraDown ? '· Jira unavailable' : ''}</Text>
        </Box>
        {report.commits.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>{`Commits (${commitCount})`}</Text>
            {report.commits.map(c => (
              <Box key={`commits-${c.repo}`} flexDirection="row" gap={1} paddingLeft={2}>
                <Box width={repoWidth} flexShrink={0}>
                  <Text dimColor wrap="truncate">{cut(c.repo, repoWidth).padEnd(repoWidth)}</Text>
                </Box>
                <Text wrap="truncate">{cut(commitText(c), inner - 2 - repoWidth - 1)}</Text>
              </Box>
            ))}
          </Box>
        )}
        {report.prs.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>PRs</Text>
            {report.prs.map(p => (
              <Box key={`pr-${p.kind}-${p.repo}-${p.number}`} flexDirection="row" gap={1} paddingLeft={2}>
                <Box width={kindWidth} flexShrink={0}>
                  <Text color={MARK[p.kind]!.colour}>{MARK[p.kind]!.mark.padEnd(kindWidth)}</Text>
                </Box>
                <Box width={numWidth} flexShrink={0}>
                  <Button
                    key={`open-${p.kind}-${p.repo}-${p.number}`}
                    plain
                    label={`#${p.number}`}
                    hover={{ underline: true }}
                    onPress={() => openInBrowser($, p.url)}
                  />
                </Box>
                <Text wrap="truncate">{cut(p.title, inner - 2 - kindWidth - numWidth - repoWidth - 3)}</Text>
                <Box flexGrow={1} />
                <Box width={repoWidth} flexShrink={0}>
                  <Text dimColor wrap="truncate">{cut(p.repo, repoWidth).padStart(repoWidth)}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}
        {report.jira.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>{`Jira (${report.jira.length})`}</Text>
            {report.jira.map(j => (
              <Box key={`jira-${j.key}`} flexDirection="row" gap={1} paddingLeft={2}>
                <Box width={keyWidth} flexShrink={0}>
                  {j.url ? (
                    <Button key={`key-${j.key}`} plain label={j.key} hover={{ underline: true }} onPress={() => openInBrowser($, j.url)} />
                  ) : (
                    <Text>{j.key}</Text>
                  )}
                </Box>
                <Text wrap="truncate">{cut(j.summary, inner - 2 - keyWidth - statusWidth - 2)}</Text>
                <Box flexGrow={1} />
                <Box width={statusWidth} flexShrink={0}>
                  <Text color={ISSUE_STATUS_COLOUR(j.status, (j.category as Category) || '')}>{`→ ${statusCut(j.status)}`}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}
        {!empty && (
          <Box marginTop={1}>
            <Button
              key="draft"
              label="Draft update"
              onPress={async () => {
                const { isFilled } = await $.prompt.fill({ text: draftOf(report), mode: 'replace' })
                if (!isFilled) $.ui.toast("Couldn't put the draft in the prompt box")
              }}
            />
          </Box>
        )}
      </Box>
    )
  })
}
