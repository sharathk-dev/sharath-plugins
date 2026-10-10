import { expect, mock, test } from 'claude-code/testing'

const NOW = new Date(2026, 9, 12, 10, 30).getTime()
const RUN = (args = '') => ({ command: 'standup', args }) as any

const tools = (...names: string[]) => ({ value: names.map(name => ({ name, description: '', mcp: name.startsWith('mcp__') })) }) as any
const JIRA_TOOLS = ['mcp__a__searchJiraIssuesUsingJql', 'mcp__a__getAccessibleAtlassianResources']

const mount = ($: any, text: string) =>
  $.ui.mount({ plugin: 'standup', surface: 'terminal', component: 'CommandOutput', props: { command: 'standup', args: '', text, isErrored: false } })

const repo = (n: string) => ({ nameWithOwner: `me/${n}` })
const pr = (number: number, title: string, r = 'web') => ({ number, title, url: `https://github.com/me/${r}/pull/${number}`, repository: repo(r) })

const activity = (over: Record<string, unknown> = {}) => ({
  viewer: {
    id: 'U_1', login: 'me',
    contributionsCollection: {
      commitContributionsByRepository: [
        { repository: repo('api'), contributions: { totalCount: 1 } },
        { repository: repo('web'), contributions: { totalCount: 7 } },
      ],
      pullRequestContributions: { nodes: [{ pullRequest: pr(5, 'Add modulo') }, { pullRequest: pr(2, 'Document layout') }] },
      pullRequestReviewContributions: { nodes: [{ pullRequest: pr(12, 'Session hardening', 'api') }] },
    },
  },
  merged: { nodes: [pr(2, 'Document layout')] },
  ...over,
})

const history = (r: string, ...msgs: string[]) => ({ [r]: { defaultBranchRef: { target: { history: { nodes: msgs.map(messageHeadline => ({ messageHeadline })) } } } } })

const ok = (data: unknown) => ({ value: { exitCode: 0, stderr: '', stdout: JSON.stringify({ data }) } }) as any

const jiraAnswer = (issues: unknown[]) => ({
  value: { content: [{ type: 'text' as const, text: JSON.stringify({ data: { resources: [{ cloudId: 'c1', url: 'https://jira.example.com' }], issues } }) }], isError: false },
})

const ISSUE = { key: 'KAN-3', fields: { summary: 'Login page', status: { name: 'In Review', statusCategory: { key: 'indeterminate' } } } }

// gh answers round trip 1 with the activity and round trip 2 with the commit headlines (web has the most commits, so it is r0).
function fakeGh(on: any, act = activity(), calls: string[][] = []) {
  on('process.run', async (_$: any, e: any) => {
    if (e.argv[0] !== 'gh') return { value: { exitCode: 0, stdout: '', stderr: '' } } as any
    calls.push([...e.argv])
    return e.argv.some((a: string) => a.startsWith('query=query($since')) ? ok({ ...history('r0', 'Add modulo', 'Fix divide by zero', 'c', 'd', 'e'), ...history('r1', 'Api change') }) : ok(act)
  })
  return calls
}

test('/standup shows commits, PRs and Jira since Friday on a Monday, in two GraphQL round trips', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => tools(...JIRA_TOOLS))
  const calls = fakeGh(on)
  const jqls: string[] = []
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'getAccessibleAtlassianResources') return jiraAnswer([])
    jqls.push(String(e.args.jql))
    return jiraAnswer([ISSUE])
  })
  const { text } = await $.command.run(RUN())
  expect(calls).toHaveLength(2)
  const first = calls[0]!.join(' ')
  expect(first).toContain(`from=${new Date(2026, 9, 9).toISOString()}`)
  expect(first).toContain(`to=${new Date(NOW).toISOString()}`)
  expect(first).toContain(`merged=is:pr author:@me merged:${new Date(2026, 9, 9).toISOString()}..${new Date(NOW).toISOString()}`)
  expect(calls[1]!.join(' ')).toContain('author=U_1')
  expect(calls[1]!.join(' ')).toContain('-f o0=me -f n0=web')
  expect(jqls[0]).toContain('status CHANGED BY currentUser() DURING ("2026-10-09 00:00", "2026-10-12 10:30")')

  expect(text).toBe([
    'Standup · Fri 9 – Mon 12 Oct · {Since Friday}',
    '### Commits (8)',
    '- web (7): Add modulo · Fix divide by zero · c · d · e',
    '- api (1): Api change',
    '### PRs',
    '- merged [web#2](https://github.com/me/web/pull/2) Document layout',
    '- opened [web#5](https://github.com/me/web/pull/5) Add modulo',
    '- reviewed [api#12](https://github.com/me/api/pull/12) Session hardening',
    '### Jira',
    '- [KAN-3](https://jira.example.com/browse/KAN-3) Login page · In Review/In Progress',
  ].join('\n'))

  const ui = await mount($, text ?? '')
  expect(await ui.find({ type: 'Text', text: 'Standup · Fri 9 – Mon 12 Oct' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Commits (8)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Add modulo · Fix divide by zero · +5 more' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✓ merged' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↑ opened/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◎ reviewed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'PRs' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Jira (1)' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'In Review' }))?.props?.color).toBe('magenta')
  expect(await ui.find({ type: 'Text', text: /Jira unavailable/ })).toBeUndefined()
})

test('/standup links: PR numbers and Jira keys open in the browser', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => tools(...JIRA_TOOLS))
  const opened: string[] = []
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'gh') return ok(activity())
    opened.push(e.argv[1]!)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as any
  })
  on('mcp.call', async () => jiraAnswer([ISSUE]))
  const { text } = await $.command.run(RUN())
  const ui = await mount($, text ?? '')
  await ui.press({ key: 'open-merged-web-2' })
  await ui.press({ key: 'key-KAN-3' })
  expect(opened).toEqual(['https://github.com/me/web/pull/2', 'https://jira.example.com/browse/KAN-3'])
})

test('Draft update fills the prompt box with a plain-text draft and does not send it', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => tools(...JIRA_TOOLS))
  fakeGh(on)
  on('mcp.call', async () => jiraAnswer([ISSUE]))
  const filled: any[] = []
  on('prompt.fill', async (_$, e) => { filled.push(e); return { isFilled: true } as any })
  let submitted = 0
  on('prompt.submit', async () => { submitted++; return undefined as any })
  const { text } = await $.command.run(RUN())
  const ui = await mount($, text ?? '')
  await ui.press({ key: 'draft' })
  expect(filled).toHaveLength(1)
  expect(filled[0].text).toBe([
    'Since Friday:',
    '- 8 commits in web, api (Add modulo; Fix divide by zero; c)',
    '- Merged web#2 Document layout',
    '- Opened web#5 Add modulo',
    '- Reviewed api#12 Session hardening',
    '- KAN-3 Login page -> In Review',
    '',
    'Today: continue KAN-3 Login page',
    'Blockers: none',
  ].join('\n'))
  expect(submitted).toBe(0)
})

test('/standup yesterday, today and 3d send those windows', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => tools('Read'))
  const calls = fakeGh(on, activity({ merged: { nodes: [] } }))
  const yesterday = await $.command.run(RUN('yesterday'))
  expect(calls[0]!.join(' ')).toContain(`from=${new Date(2026, 9, 11).toISOString()}`)
  expect(calls[0]!.join(' ')).toContain(`to=${new Date(2026, 9, 12).toISOString()}`)
  expect(yesterday.text).toContain('Standup · Sun 11 Oct · Jira unavailable · {Yesterday}')
  calls.length = 0
  const today = await $.command.run(RUN('today'))
  expect(calls[0]!.join(' ')).toContain(`from=${new Date(2026, 9, 12).toISOString()}`)
  expect(calls[0]!.join(' ')).toContain(`to=${new Date(NOW).toISOString()}`)
  expect(today.text).toContain('Standup · Mon 12 Oct (today) · Jira unavailable')
  calls.length = 0
  const days = await $.command.run(RUN('3d'))
  expect(calls[0]!.join(' ')).toContain(`from=${new Date(2026, 9, 9).toISOString()}`)
  expect(days.text).toContain('Standup · last 3 days, Fri 9 Oct - Mon 12 Oct')
  const bad = await $.command.run(RUN('nonsense'))
  expect(bad.text).toMatch(/^Unknown argument "nonsense"/)
  expect(bad.text).toContain('/standup yesterday')
  expect(calls).toHaveLength(2)
})

test('a Jira server that never answers hides the Jira section and says so in the header', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('tool.list', async () => tools(...JIRA_TOOLS))
  fakeGh(on)
  on('mcp.call', () => new Promise(() => {}) as any)
  let out: string | undefined
  const run = $.command.run(RUN()).then(r => { out = r.text })
  await clock.settle()
  expect(out).toBeUndefined()
  await clock.advance(4000)
  await run
  expect(out).toContain('Standup · Fri 9 – Mon 12 Oct · Jira unavailable · {Since Friday}')
  expect(out).not.toContain('### Jira')
  expect(out).toContain('### Commits (8)')
  const ui = await mount($, out ?? '')
  expect(await ui.find({ type: 'Text', text: '· Jira unavailable' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Jira/ })).toBeUndefined()
})

test('no Jira server connected is the same as unavailable', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => tools('Read'))
  fakeGh(on)
  const { text } = await $.command.run(RUN())
  expect(text).toContain('· Jira unavailable')
})

test('empty results say nothing was found, and empty Jira is not "unavailable"', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => tools(...JIRA_TOOLS))
  on('process.run', async () => ok({
    viewer: { id: 'U_1', login: 'me', contributionsCollection: { commitContributionsByRepository: [], pullRequestContributions: { nodes: [] }, pullRequestReviewContributions: { nodes: [] } } },
    merged: { nodes: [] },
  }))
  on('mcp.call', async () => jiraAnswer([]))
  const { text } = await $.command.run(RUN())
  expect(text).toBe('Nothing found for Fri 9 – Mon 12 Oct')
  const ui = await mount($, text ?? '')
  expect(await ui.find({ type: 'Text', text: 'Nothing found for Fri 9 – Mon 12 Oct' })).toBeDefined()
  expect(await ui.find({ key: 'draft' })).toBeUndefined()
})

test('only GitHub empty: Jira alone still draws, and empty sections are omitted', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => tools(...JIRA_TOOLS))
  on('process.run', async () => ok({
    viewer: { id: 'U_1', login: 'me', contributionsCollection: { commitContributionsByRepository: [], pullRequestContributions: { nodes: [] }, pullRequestReviewContributions: { nodes: [] } } },
    merged: { nodes: [] },
  }))
  on('mcp.call', async () => jiraAnswer([ISSUE]))
  const { text } = await $.command.run(RUN())
  expect(text).not.toContain('### Commits')
  expect(text).not.toContain('### PRs')
  const ui = await mount($, text ?? '')
  expect(await ui.find({ type: 'Text', text: 'Jira (1)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Commits/ })).toBeUndefined()
})

test('commit headlines are asked of five repos at most, and a failed second call keeps the counts', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => tools('Read'))
  const many = activity()
  many.viewer.contributionsCollection.commitContributionsByRepository = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => ({ repository: repo(n), contributions: { totalCount: 10 - i } }))
  const calls: string[][] = []
  on('process.run', async (_$, e) => {
    calls.push([...e.argv])
    if (e.argv.some(a => a.startsWith('query=query($since'))) return { value: { exitCode: 1, stdout: '', stderr: 'boom' } } as any
    return ok(many)
  })
  const { text } = await $.command.run(RUN())
  expect(calls).toHaveLength(2)
  expect(calls[1]!.join(' ')).toContain('n4=e')
  expect(calls[1]!.join(' ')).not.toContain('n5=')
  expect(text).toContain('### Commits (49)')
  expect(text).toContain('- a (10): \n')
})

test('/standup says why when gh fails', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => tools('Read'))
  on('process.run', async () => ({ value: { exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run: gh auth login\n' } }) as any)
  const { text } = await $.command.run(RUN())
  expect(text).toBe("Couldn't load standup: To get started with GitHub CLI, please run: gh auth login")
})

test('every section lists the newest first', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => tools(...JIRA_TOOLS))
  const dated = (number: number, title: string, extra: Record<string, unknown>) => ({ ...pr(number, title), ...extra })
  on('process.run', async (_$, e) => {
    if (e.argv.some(a => a.startsWith('query=query($since'))) {
      const node = (messageHeadline: string, committedDate: string) => ({ messageHeadline, committedDate })
      return ok({
        r0: { defaultBranchRef: { target: { history: { nodes: [node('web old', '2026-10-10T08:00:00Z'), node('web new', '2026-10-10T09:00:00Z')] } } } },
        r1: { defaultBranchRef: { target: { history: { nodes: [node('api latest', '2026-10-11T07:00:00Z')] } } } },
      })
    }
    return ok({
      viewer: {
        id: 'U_1', login: 'me',
        contributionsCollection: {
          commitContributionsByRepository: [
            { repository: repo('web'), contributions: { totalCount: 5 } },
            { repository: repo('api'), contributions: { totalCount: 1 } },
          ],
          pullRequestContributions: { nodes: [{ pullRequest: dated(5, 'opened mid', { createdAt: '2026-10-10T12:00:00Z' }) }] },
          pullRequestReviewContributions: { nodes: [
            { occurredAt: '2026-10-10T10:00:00Z', pullRequest: pr(12, 'reviewed oldest', 'api') },
            { occurredAt: '2026-10-11T06:00:00Z', pullRequest: pr(13, 'reviewed newest', 'api') },
          ] },
        },
      },
      merged: { nodes: [dated(2, 'merged older', { mergedAt: '2026-10-10T11:00:00Z' }), dated(3, 'merged newer', { mergedAt: '2026-10-10T13:00:00Z' })] },
    })
  })
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'getAccessibleAtlassianResources') return jiraAnswer([])
    const issue = (key: string, updated: string) => ({ key, fields: { summary: key, updated, status: { name: 'Done', statusCategory: { key: 'done' } } } })
    return jiraAnswer([issue('KAN-1', '2026-10-10T09:00:00Z'), issue('KAN-2', '2026-10-11T09:00:00Z'), issue('KAN-3', '2026-10-10T20:00:00Z')])
  })
  const { text } = await $.command.run(RUN())
  const lines = (text ?? '').split('\n')
  expect(lines.filter(l => l.startsWith('- ') && !l.includes('KAN-') && !l.includes('github.com')).map(l => l.split(':')[0])).toEqual(['- api (1)', '- web (5)'])
  expect(lines).toContain('- web (5): web new · web old')
  expect(lines.filter(l => l.includes('github.com')).map(l => l.split(') ')[1])).toEqual(['reviewed newest', 'merged newer', 'opened mid', 'merged older', 'reviewed oldest'])
  expect(lines.filter(l => l.includes('KAN-')).map(l => l.slice(2, 14))).toEqual(['[KAN-2](http', '[KAN-3](http', '[KAN-1](http'])
})

test('the Jira status column is one fixed width and left-aligned, like the /jira card', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => tools(...JIRA_TOOLS))
  fakeGh(on)
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'getAccessibleAtlassianResources') return jiraAnswer([])
    return jiraAnswer([
      { ...ISSUE, key: 'KAN-3', fields: { ...ISSUE.fields, status: { name: 'In Review' } } },
      { ...ISSUE, key: 'KAN-4', fields: { ...ISSUE.fields, status: { name: 'Done' } } },
    ])
  })
  const { text } = await $.command.run(RUN())
  const ui = await mount($, text ?? '')
  const cells: any[] = []
  const walk = (n: any) => {
    if (n?.type === 'Box' && n.props?.flexShrink === 0 && (Array.isArray(n.children) ? n.children : []).some((c: any) => /^(In Review|Done) *$/.test(String(c?.children?.[0] ?? c?.text ?? '')))) cells.push(n)
    for (const c of Array.isArray(n?.children) ? n.children : []) walk(c)
  }
  walk(await ui.drawn())
  expect(cells.map(c => c.props.width)).toEqual([9, 9])
  expect(await ui.find({ type: 'Text', text: 'Done     ' })).toBeDefined()
})

test('commit headlines also come from the head branches of my PRs, deduped by oid and newest first', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => tools('Read'))
  const commit = (oid: string, messageHeadline: string, committedDate: string) => ({ oid, messageHeadline, committedDate })
  const hist = (...nodes: unknown[]) => ({ target: { history: { nodes } } })
  const calls: string[] = []
  on('process.run', async (_$, e) => {
    const joined = e.argv.join(' ')
    if (e.argv.some(a => a.startsWith('query=query($since'))) {
      calls.push(joined)
      return ok({
        r0: { defaultBranchRef: hist(commit('m1', 'main change', '2026-10-10T08:00:00Z'), commit('shared', 'shared base', '2026-10-09T09:00:00Z')) },
        b0_0: { ref: hist(commit('f2', 'branch newest', '2026-10-11T09:00:00Z'), commit('shared', 'shared base', '2026-10-09T09:00:00Z')) },
        b0_1: { ref: hist(commit('f1', 'other branch', '2026-10-10T20:00:00Z')) },
      })
    }
    calls.push(joined)
    const act = activity()
    act.viewer.contributionsCollection.commitContributionsByRepository = [{ repository: repo('web'), contributions: { totalCount: 1 } }]
    ;(act.viewer as any).pullRequests = { nodes: [
      { headRefName: 'feature/new', updatedAt: '2026-10-11T09:00:00Z', repository: repo('web') },
      { headRefName: 'feature/other', updatedAt: '2026-10-10T20:00:00Z', repository: repo('web') },
      { headRefName: 'feature/stale', updatedAt: '2026-09-01T00:00:00Z', repository: repo('web') },
      { headRefName: 'elsewhere', updatedAt: '2026-10-11T09:00:00Z', repository: repo('api') },
    ] }
    return ok(act)
  })
  const { text } = await $.command.run(RUN())
  expect(calls).toHaveLength(2)
  expect(calls[0]).toContain('pullRequests(states: OPEN')
  expect(calls[1]).toContain('-f b0_0=refs/heads/feature/new -f b0_1=refs/heads/feature/other')
  expect(calls[1]).not.toContain('feature/stale')
  expect(calls[1]).not.toContain('elsewhere')
  expect(text).toContain('### Commits (4)')
  expect(text).toContain('- web (4): branch newest · other branch · main change · shared base')
})

test('the count never drops below the headlines shown, so "+N more" is never negative', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('tool.list', async () => tools('Read'))
  on('process.run', async (_$, e) => {
    if (e.argv.some(a => a.startsWith('query=query($since'))) {
      const nodes = ['a', 'b', 'c'].map((m, i) => ({ oid: m, messageHeadline: m, committedDate: `2026-10-1${i}T00:00:00Z` }))
      return ok({ r0: { defaultBranchRef: { target: { history: { nodes } } } } })
    }
    const act = activity()
    act.viewer.contributionsCollection.commitContributionsByRepository = [{ repository: repo('web'), contributions: { totalCount: 1 } }]
    return ok(act)
  })
  const { text } = await $.command.run(RUN())
  expect(text).toContain('- web (3): c · b · a')
  const ui = await mount($, text ?? '')
  expect(await ui.find({ type: 'Text', text: 'c · b · +1 more' })).toBeDefined()
})
