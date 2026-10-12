import { expect, mock, test } from 'claude-code/testing'

const RUN = { command: 'pr', args: '' } as any

function tools(...names: string[]) {
  return { value: names.map(name => ({ name, description: '', mcp: name.startsWith('mcp__') })) } as any
}

const JIRA_TOOLS = ['mcp__a__searchJiraIssuesUsingJql', 'mcp__a__getAccessibleAtlassianResources']

const gh = (mine: unknown[], review: unknown[] = []) =>
  ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify({ data: { viewer: { login: 'me' }, mine: { nodes: mine }, review: { nodes: review } } }) } }) as any

const mount = ($: any, text: string, columns?: number) =>
  $.ui.mount({
    plugin: 'pr-status', surface: 'terminal', component: 'CommandOutput',
    props: { command: 'pr', args: '', text, isErrored: false },
    ...(columns ? { viewport: { columns, rows: 50 } } : {}),
  })

const jiraAnswer = (issues: unknown[]) => ({
  value: { content: [{ type: 'text' as const, text: JSON.stringify({ data: { resources: [{ cloudId: 'c1', url: 'https://x.atlassian.net' }], issues } }) }], isError: false },
})

const thread = (isResolved: boolean, by: string) => ({ isResolved, comments: { nodes: [{ author: { login: by } }] } })

const node = (over: Record<string, unknown>) => ({
  number: 1, title: 'x', url: 'https://github.com/o/r/pull/1', isDraft: false, reviewDecision: 'REVIEW_REQUIRED',
  headRefName: 'main', repository: { name: 'web' }, author: { login: 'me' },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...over,
})

test('/pr lists my PRs and review requests with review, CI and issue key', async ($, on) => {
  const opened: string[] = []
  mock.clock(on)
  on('tool.list', async () => tools('Read'))
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'gh') {
      expect(e.argv.slice(0, 3)).toEqual(['gh', 'api', 'graphql'])
      return { value: { exitCode: 0, stderr: '', stdout: JSON.stringify({ data: {
        viewer: { login: 'me' },
        mine: { nodes: [
          node({ number: 7544, title: 'INT-352 | Drive WhatsApp banner', url: 'https://github.com/o/web/pull/7544', reviewDecision: 'APPROVED',
            reviewThreads: { nodes: [thread(true, 'bob'), thread(true, 'me'), thread(true, 'bob'), thread(false, 'bob')] } }),
          node({ number: 19, title: 'Use model jars', headRefName: 'feature/AER-64', repository: { name: 'api-reports' }, isDraft: true,
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }),
          node({ number: 674, title: 'AER-64: Consume models', reviewDecision: 'CHANGES_REQUESTED', commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
            reviewThreads: { nodes: [thread(false, 'me'), thread(false, 'me')] } }),
        ] },
        review: { nodes: [node({ number: 12, title: 'Session hardening', author: { login: 'alice' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } })] },
      } }) } } as any
    }
    opened.push(e.argv[1]!)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as any
  })

  const { text: out } = await $.command.run(RUN)
  expect((out ?? '').replace(/\d\d:\d\d/, 'HH:MM')).toBe([
    'PRs · 3 mine · 1 to review · HH:MM · Jira unavailable',
    '### Mine',
    '- [web#7544](https://github.com/o/web/pull/7544) (Approved · CI passing · 3/4 threads resolved · 1 waiting on you · open by bob 1 · INT-352) INT-352 | Drive WhatsApp banner',
    '- [api-reports#19](https://github.com/o/r/pull/1) (Draft · CI failing · AER-64) Use model jars',
    '- [web#674](https://github.com/o/r/pull/1) (Changes · 0/2 threads resolved · open by you 2 · AER-64) AER-64: Consume models',
    '### Waiting on you',
    '- [web#12](https://github.com/o/r/pull/1) (Review · CI running · by alice) Session hardening',
  ].join('\n'))

  const ui = await $.ui.mount({
    plugin: 'pr-status', surface: 'terminal', component: 'CommandOutput',
    props: { command: 'pr', args: '', text: out ?? '', isErrored: false },
  })
  expect(await ui.find({ key: 'pr-web-7544' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Waiting on you/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· alice/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '3/4' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / ●1/ })).toBeDefined()
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"color":"red"')
  await ui.press({ key: 'open-web-7544' })
  expect(opened).toEqual(['https://github.com/o/web/pull/7544'])

  // Open threads: the hover note says who wrote last on each, and clicking it opens the PR.
  const wide = await mount($, out ?? '', 200)
  const wideDrawn = JSON.stringify(await wide.drawn())
  expect(wideDrawn).toContain('"label":"1 open: bob 1"')
  expect(wideDrawn).toContain('"label":"2 open: you 2"')
  await wide.press({ key: 'note-web-7544' })
  expect(opened).toEqual(['https://github.com/o/web/pull/7544', 'https://github.com/o/web/pull/7544'])
})

test('/pr says why when gh fails', async ($, on) => {
  on('process.run', async () => ({ value: { exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run: gh auth login\n' } }) as any)
  const { text: out } = await $.command.run(RUN)
  expect(out).toBe("Couldn't load PRs: To get started with GitHub CLI, please run: gh auth login")
})

test('/pr marks merge conflicts and names failing checks on my PRs only', async ($, on) => {
  mock.clock(on)
  on('tool.list', async () => tools('Read'))
  const rollup = (state: string, nodes: unknown[]) => ({ nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes } } } }] })
  on('process.run', async () => gh([
    node({ number: 5, title: 'Fix it', mergeable: 'CONFLICTING', baseRefName: 'develop', commits: rollup('FAILURE', [
      { __typename: 'CheckRun', name: 'build', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'docs', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'lint', state: 'ERROR' },
      { __typename: 'CheckRun', name: 'build', conclusion: 'TIMED_OUT' },
      { __typename: 'CheckRun', name: 'a, b · c', conclusion: 'CANCELLED' },
    ]) }),
    node({ number: 6, title: 'Fine', mergeable: 'MERGEABLE' }),
  ], [node({ number: 9, title: 'Theirs', mergeable: 'CONFLICTING', author: { login: 'al' }, commits: rollup('FAILURE', [{ __typename: 'CheckRun', name: 'x', conclusion: 'FAILURE' }]) })]))
  const { text: out } = await $.command.run(RUN)
  expect(out).toContain('(Review · conflict with develop · CI failing · failing: build, lint, a; b - c) Fix it')
  expect(out).toContain('(Review · CI passing) Fine')
  expect(out).toContain('(Review · CI failing · by al) Theirs')

  const ui = await mount($, out ?? '', 260)
  expect(await ui.find({ type: 'Text', text: 'conflict' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✗3' })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toContain('"label":"rebase on develop · ✗ build, lint, a; b - c"')
  expect(await ui.find({ type: 'Text', text: /✗ x/ })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).toMatch(/"key":"pr-web-5".*"position":"absolute","top":-1,"left":156[^}]*"display":"none"[^}]*\},"hover":\{"display":"flex"\}/)

  const narrow = await mount($, out ?? '', 85)
  expect(JSON.stringify(await narrow.drawn())).not.toContain('rebase on')

  // A wide window gives the card all but the note's room, up to its cap.
  const card = async (columns: number) => (await (await mount($, out ?? '', columns)).drawn() as any).props.width
  expect(await card(140)).toBe(101)
  expect(await card(260)).toBe(160)
  expect(await card(85)).toBe(80)
})

test('/pr reads facts that hold brackets without spilling them into the title', async $ => {
  const out = [
    'PRs · 1 mine · 0 to review · 22:22',
    '### Mine',
    '- [aeroparker-extern#202](https://x/202) (Draft · conflict · CI failing · failing: AWS CodeBuild eu-west-1 (aeroparker-external-api) · 0/6 threads resolved · AER-64 · jira: Closed (old)/Done) Add (optional) report',
  ].join('\n')
  const ui = await mount($, out, 260)
  expect(await ui.find({ type: 'Text', text: /Add \(optional\) report/ })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).toContain('✗ AWS CodeBuild eu-west-1 (aeroparker-external-api)')
  expect(await ui.find({ type: 'Text', text: '0/6' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Closed (old)' })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).not.toContain('threads resol')
})

test('/pr shows Jira statuses next to keys, red when my open PR is on a Done ticket', async ($, on) => {
  mock.clock(on)
  on('tool.list', async () => tools(...JIRA_TOOLS))
  on('process.run', async () => gh(
    [node({ number: 1, title: 'AER-1 one' }), node({ number: 2, title: 'AER-2 two' }), node({ number: 3, title: 'ZZZ-9 other site' })],
    [node({ number: 4, title: 'AER-2 review', author: { login: 'al' } })],
  ))
  const jqls: string[] = []
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'getAccessibleAtlassianResources') return jiraAnswer([])
    jqls.push(String(e.args.jql))
    expect(e.args.fields).toEqual(['summary', 'status'])
    return jiraAnswer([
      { key: 'AER-1', fields: { summary: 'a', status: { name: 'In Review', statusCategory: { key: 'indeterminate' } } } },
      { key: 'AER-2', fields: { summary: 'b', status: { name: 'Released', statusCategory: { key: 'done' } } } },
    ])
  })
  const { text: out } = await $.command.run(RUN)
  expect(jqls).toEqual(['key in (AER-1, AER-2, ZZZ-9)'])
  expect(out).toContain('(Review · CI passing · AER-1 · jira: In Review/In Progress) AER-1 one')
  expect(out).toContain('(Review · CI passing · AER-2 · jira: Released/Done) AER-2 two')
  expect(out).toContain('(Review · CI passing · ZZZ-9) ZZZ-9 other site')
  expect(out).toContain('(Review · CI passing · AER-2 · jira: Released/Done · by al) AER-2 review')
  expect(out).not.toContain('Jira unavailable')

  const ui = await mount($, out ?? '')
  expect((await ui.find({ type: 'Text', text: 'In Review' }))?.props?.color).toBe('magenta')
  const released = JSON.stringify(await ui.drawn()).split('Released')
  expect(released).toHaveLength(3)
  // Mine: red and bold; the review request for the same ticket keeps its own colour.
  expect(released[0]).toMatch(/"bold":true,"color":"red"\},"children":\["$/)
  expect(released[1]).toMatch(/"bold":false,"color":"green"\},"children":\["$/)
})

test('/pr says Jira is unavailable when no Jira tool is connected', async ($, on) => {
  mock.clock(on)
  on('tool.list', async () => tools('Read', 'mcp__a__other'))
  on('process.run', async () => gh([node({ number: 1, title: 'AER-1 one' })]))
  const { text: out } = await $.command.run(RUN)
  expect(out).toMatch(/^PRs · 1 mine · 0 to review · \d\d:\d\d · Jira unavailable\n/)
  expect(out).not.toContain('jira:')
  const ui = await mount($, out ?? '')
  expect(await ui.find({ type: 'Text', text: /· Jira unavailable$/ })).toBeDefined()
})

test('/pr gives up on a Jira server that never answers', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.list', async () => tools(...JIRA_TOOLS))
  on('process.run', async () => gh([node({ number: 1, title: 'AER-1 one' })]))
  on('mcp.call', () => new Promise(() => {}) as any)
  let out: string | undefined
  const run = $.command.run(RUN).then(r => { out = r.text })
  await clock.settle()
  expect(out).toBeUndefined()
  await clock.advance(4000)
  await run
  expect(out).toMatch(/^PRs · 1 mine · 0 to review · \d\d:\d\d · Jira unavailable\n/)
  expect(out).not.toContain('jira:')
})

test('/pr does not call Jira when no PR names an issue', async ($, on) => {
  on('tool.list', async () => tools(...JIRA_TOOLS))
  on('process.run', async () => gh([node({ number: 1, title: 'No key here' })]))
  let calls = 0
  on('mcp.call', async () => {
    calls++
    return jiraAnswer([])
  })
  const { text: out } = await $.command.run(RUN)
  expect(calls).toBe(0)
  expect(out).not.toContain('Jira')
})

test('/pr draws one left-aligned signals column, and none when no row has a signal', async ($, on) => {
  mock.clock(on)
  on('tool.list', async () => tools('Read'))
  const bare = { nodes: [{ commit: { statusCheckRollup: null } }] }
  on('process.run', async () => gh([
    node({ number: 1, title: 'Quiet', commits: bare, reviewThreads: { nodes: [thread(true, 'bob'), thread(false, 'me'), thread(false, 'me')] } }),
    node({ number: 2, title: 'Nothing', commits: bare }),
  ]))
  const { text: out } = await $.command.run(RUN)
  const ui = await mount($, out ?? '')
  expect(await ui.find({ type: 'Text', text: '1/3' })).toBeDefined()
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toMatch(/[✓✗]/)
  expect(drawn).not.toContain('"justifyContent":"flex-end"')
})

test('/pr gives every row the same signals width, as wide as the longest signals text', async ($, on) => {
  mock.clock(on)
  on('tool.list', async () => tools('Read'))
  const bare = { nodes: [{ commit: { statusCheckRollup: null } }] }
  on('process.run', async () => gh([
    node({ number: 1, title: 'Conflicted', mergeable: 'CONFLICTING', commits: bare }),
    node({ number: 2, title: 'Threads', commits: bare, reviewThreads: { nodes: [thread(false, 'bob'), thread(true, 'me'), thread(true, 'me')] } }),
    node({ number: 3, title: 'Nothing', commits: bare }),
  ]))
  const { text: out } = await $.command.run(RUN)
  const ui = await mount($, out ?? '')
  const columns: any[] = []
  const walk = (n: any) => {
    if (n?.type === 'Box' && n.props?.gap === 2 && n.props?.flexShrink === 0) columns.push(n)
    for (const c of Array.isArray(n?.children) ? n.children : []) walk(c)
  }
  walk(await ui.drawn())
  expect(columns.map(c => c.props.width)).toEqual([8, 8, 8])
  expect(columns.some(c => c.props.justifyContent === 'flex-end')).toBe(false)
})

test('/pr draws threads, conflict and CI together on one row', async ($, on) => {
  mock.clock(on)
  on('tool.list', async () => tools('Read'))
  on('process.run', async () => gh([
    node({ number: 3, title: 'Busy', mergeable: 'CONFLICTING', reviewThreads: { nodes: [thread(false, 'bob'), thread(true, 'bob')] } }),
  ]))
  const { text: out } = await $.command.run(RUN)
  const busy = await mount($, out ?? '')
  expect(await busy.find({ type: 'Text', text: '1/2' })).toBeDefined()
  expect(await busy.find({ type: 'Text', text: / ●1/ })).toBeDefined()
  expect(await busy.find({ type: 'Text', text: 'conflict' })).toBeDefined()
  expect(await busy.find({ type: 'Text', text: '✓' })).toBeDefined()
})

test('/pr nests stacked PRs under the PR they are based on', async ($, on) => {
  mock.clock(on)
  on('tool.list', async () => tools('Read'))
  const repo = { name: 'web', defaultBranchRef: { name: 'main' } }
  on('process.run', async () => gh([
    node({ number: 1, title: 'Base', headRefName: 'feature/a', baseRefName: 'main', repository: repo }),
    node({ number: 8, title: 'Lonely', headRefName: 'feature/d', baseRefName: 'release/x', repository: repo }),
    node({ number: 7, title: 'Top', headRefName: 'feature/c', baseRefName: 'feature/b', repository: repo }),
    node({ number: 6, title: 'Middle', headRefName: 'feature/b', baseRefName: 'feature/a', repository: repo }),
  ]))
  const { text: out } = await $.command.run(RUN)
  const rows = (out ?? '').split('\n').filter(l => l.includes('- [')).map(l => l.replace(/\(https[^)]*\)/, ''))
  expect(rows).toEqual([
    '- [web#1] (Review · CI passing) Base',
    '  - [web#6] (Review · CI passing · on #1) Middle',
    '    - [web#7] (Review · CI passing · on #6) Top',
    '- [web#8] (Review · CI passing · on release/x) Lonely',
  ])
  const ui = await mount($, out ?? '')
  expect(await ui.find({ type: 'Text', text: /^└─ / })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: 'PR#6' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /on release\/x/ })).toBeDefined()
})

test('/pr links Jira keys with a server that gives no site (jira_search), from the issues themselves', async ($, on) => {
  mock.clock(on)
  const opened: string[] = []
  on('tool.list', async () => tools('mcp__b__jira_search'))
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'gh') return gh([node({ number: 1, title: 'AER-1 one' })])
    opened.push(e.argv[1]!)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as any
  })
  on('mcp.call', async () => ({
    value: { content: [{ type: 'text' as const, text: JSON.stringify({ issues: [
      { key: 'AER-1', url: 'https://jira.example.com/browse/AER-1', summary: 'a', status: { name: 'In Review', category: 'In Progress' } },
    ] }) }], isError: false },
  }))
  const { text: out } = await $.command.run(RUN)
  expect(out).toContain('jira: In Review/In Progress')
  const ui = await mount($, out ?? '')
  expect(await ui.find({ type: 'Button', label: 'AER-1' })).toBeDefined()
  await ui.press({ key: 'key-web-1' })
  expect(opened).toEqual(['https://jira.example.com/browse/AER-1'])
})

test('card style: magenta border, gradient title, review states coloured and left-aligned', async ($, on) => {
  mock.clock(on)
  on('tool.list', async () => tools('Read'))
  on('process.run', async () => gh([node({ number: 1, title: 'one' }), node({ number: 2, title: 'two', isDraft: true })]))
  const { text: out } = await $.command.run(RUN)
  const ui = await mount($, out ?? '')
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"borderColor":"magenta"')
  expect(drawn).not.toContain('"borderDimColor"')
  expect(drawn).toContain('"color":"#ff5fa2"},"children":["P"]')
  const review = await ui.find({ type: 'Text', text: /^Review\s*$/ })
  expect(review?.props?.color).toBe('magenta')
  expect((await ui.find({ type: 'Text', text: /^Draft\s*$/ }))?.props?.color).toBe('yellow')
  expect(await ui.find({ type: 'Text', text: /^\s+Draft$/ })).toBeUndefined()
})
