import { expect, test } from 'claude-code/testing'

const ISSUES = [
  { key: 'KAN-1', fields: { summary: 'Write docs', status: { name: 'To Do' } } },
  { key: 'KAN-2', fields: { summary: 'Fix login page', status: { name: 'In Progress' } } },
  { key: 'KAN-3', fields: { summary: 'Add tests', status: { name: 'To Do' } } },
]

const RUN = { command: 'jira', args: '' } as any

function text(value: unknown) {
  return { value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } }
}

function tools(...names: string[]) {
  return { value: names.map(name => ({ name, description: '', mcp: name.startsWith('mcp__') })) } as any
}

test('detects Atlassian MCP by its tools, lists tasks grouped by status, and draws a card', async ($, on) => {
  on('tool.list', async () => tools('Read', 'mcp__plugin_atlassian_atlassian__getJiraIssue', 'mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql'))
  const opened: string[][] = []
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'gh') {
      const prs = [
        { number: 19, title: 'KAN-2: fix the login page', url: 'https://github.com/o/web/pull/19', repository: { name: 'web' }, isDraft: false },
        { number: 20, title: 'KAN-2 follow-up', url: 'https://github.com/o/web/pull/20', repository: { name: 'web' }, isDraft: true },
        { number: 21, title: 'KAN-21 is not KAN-2', url: 'https://github.com/o/web/pull/21', repository: { name: 'web' }, isDraft: false },
        { number: 5, title: 'Unrelated', url: 'https://github.com/o/api/pull/5', repository: { name: 'api' }, isDraft: false },
      ]
      return { value: { exitCode: 0, stdout: JSON.stringify(prs), stderr: '' } } as any
    }
    opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as any
  })
  const calls: string[] = []
  on('mcp.call', async (_$, e) => {
    calls.push(`${e.server}/${e.tool}`)
    if (e.tool === 'getAccessibleAtlassianResources')
      return text({ data: { resources: [{ cloudId: 'c1', url: 'https://x.atlassian.net' }] } })
    expect(e.args.cloudId).toBe('c1')
    return text({ data: { isLast: true, issues: ISSUES } })
  })

  const { text: out } = await $.command.run(RUN)
  expect(out).toEqual(
    expect.stringMatching(
      /^Jira · 3 open · \d\d:\d\d\n### In Progress\n- \[KAN-2\]\(https:\/\/x\.atlassian\.net\/browse\/KAN-2\) \(Task\) Fix login page\n  - PR \[web#19\]\(https:\/\/github\.com\/o\/web\/pull\/19\) open\n  - PR \[web#20\]\(https:\/\/github\.com\/o\/web\/pull\/20\) draft\n  - PR \[web#21\]\(https:\/\/github\.com\/o\/web\/pull\/21\) open\n### To Do\n- \[KAN-1\]\(https:\/\/x\.atlassian\.net\/browse\/KAN-1\) \(Task\) Write docs\n- \[KAN-3\]\(https:\/\/x\.atlassian\.net\/browse\/KAN-3\) \(Task\) Add tests$/,
    ),
  )
  expect(calls[0]).toBe('plugin_atlassian_atlassian/getAccessibleAtlassianResources')

  await $.command.run(RUN)
  expect(calls.filter(c => c.endsWith('getAccessibleAtlassianResources'))).toHaveLength(1)

  const ui = await $.ui.mount({
    plugin: 'jira-tasks', surface: 'terminal', component: 'CommandOutput',
    props: { command: 'jira', args: '', text: out ?? '', isErrored: false },
  })
  expect(await ui.find({ key: 'row-KAN-3' })).toBeDefined()
  await ui.press({ key: 'open-KAN-3' })
  await ui.press({ key: 'pr-KAN-2' })
  expect(opened).toEqual([['xdg-open', 'https://x.atlassian.net/browse/KAN-3'], ['xdg-open', 'https://github.com/o/web/pull/19']])
  expect(await ui.find({ type: 'Text', text: /^ \+2$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Fix login page/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ ● Task $/ })).toBeDefined()
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"borderColor":"magenta"')
  expect(drawn).not.toContain('"borderDimColor"')
  expect(drawn).toContain('"color":"#ff5fa2"},"children":["J"]')
})

test('colours and orders custom board statuses by their Jira category', async ($, on) => {
  const st = (name: string, key: string) => ({ name, statusCategory: { key } })
  on('tool.list', async () => tools('mcp__a__searchJiraIssuesUsingJql'))
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'getAccessibleAtlassianResources') return text({ data: { resources: [{ cloudId: 'c1', url: 'https://x.atlassian.net' }] } })
    expect(e.args.view).toBe('evidence')
    return text({ data: { issues: [
      { key: 'K-1', fields: { summary: 'Triage me', status: st('Triage', 'new') } },
      { key: 'K-2', fields: { summary: 'Building', status: st('Doing', 'indeterminate') } },
      { key: 'K-3', fields: { summary: 'Check it', status: st('QA', 'indeterminate') } },
      { key: 'K-4', fields: { summary: 'Stuck', status: st('Waiting on vendor hold', 'indeterminate') } },
    ] } })
  })
  const { text: out } = await $.command.run(RUN)
  const headers = (out ?? '').split('\n').filter(l => l.startsWith('### '))
  expect(headers).toEqual(['### Waiting on vendor hold (In Progress)', '### QA (In Progress)', '### Doing (In Progress)', '### Triage (To Do)'])

  const ui = await $.ui.mount({
    plugin: 'jira-tasks', surface: 'terminal', component: 'CommandOutput',
    props: { command: 'jira', args: '', text: out ?? '', isErrored: false },
  })
  const colour = async (status: string) => (await ui.find({ type: 'Text', text: new RegExp(`^${status}\\s*$`) }))?.props?.color
  expect(await colour('Waiting on vendor hold')).toBe('red')
  expect(await colour('QA')).toBe('magenta')
  expect(await colour('Doing')).toBe('yellow')
  expect(await colour('Triage')).toBe('cyan')
})

test('nests subtasks under a listed parent and points orphans at theirs', async ($, on) => {
  const st = (name: string, key: string) => ({ name, statusCategory: { key } })
  const task = { name: 'Task', subtask: false }
  const sub = { name: 'Subtask', subtask: true }
  on('tool.list', async () => tools('mcp__a__searchJiraIssuesUsingJql'))
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'getAccessibleAtlassianResources') return text({ data: { resources: [{ cloudId: 'c1', url: 'https://x.atlassian.net' }] } })
    expect(e.args.fields).toContain('parent')
    return text({ data: { issues: [
      { key: 'KAN-10', fields: { summary: 'Check chips', status: st('To Do', 'new'), issuetype: sub, parent: { key: 'KAN-1' } } },
      { key: 'KAN-1', fields: { summary: 'Task 1', status: st('In Progress', 'indeterminate'), issuetype: task } },
      { key: 'KAN-11', fields: { summary: 'Verify link', status: st('In Progress', 'indeterminate'), issuetype: sub, parent: { key: 'KAN-1' } } },
      { key: 'KAN-13', fields: { summary: 'Add screenshots', status: st('To Do', 'new'), issuetype: sub, parent: { key: 'KAN-9' } } },
    ] } })
  })
  const { text: out } = await $.command.run(RUN)
  const body = (out ?? '').split('\n').slice(1).map(l => l.replace(/\]\([^)]*\)/, ']'))
  expect(body).toEqual([
    '### In Progress',
    '- [KAN-1] (Task) Task 1',
    '  - [KAN-11] (Subtask · In Progress) Verify link',
    '  - [KAN-10] (Subtask · To Do) Check chips',
    '### To Do',
    '- [KAN-13] (Subtask · in KAN-9) Add screenshots',
  ])

  const ui = await $.ui.mount({
    plugin: 'jira-tasks', surface: 'terminal', component: 'CommandOutput',
    props: { command: 'jira', args: '', text: out ?? '', isErrored: false },
  })
  expect(await ui.find({ type: 'Text', text: /^  ├─ ↳/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  └─ ↳/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↑ KAN-9/ })).toBeDefined()
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn.indexOf('Verify link')).toBeLessThan(drawn.indexOf('Check chips'))
})

test('detects an mcp-atlassian style server (jira_search) and its flattened issues', async ($, on) => {
  on('tool.list', async () => tools('mcp__corp-jira__jira_get_issue', 'mcp__corp-jira__jira_search'))
  on('mcp.call', async (_$, e) => {
    expect(e.server).toBe('corp-jira')
    expect(e.tool).toBe('jira_search')
    expect(e.args.jql).toContain('currentUser()')
    return text({
      total: 1,
      issues: [{ key: 'PAY-7', summary: 'Rotate keys', status: { name: 'In Review' }, issue_type: { name: 'Bug' },
        self: 'https://jira.corp.example/rest/api/2/issue/123' }],
    })
  })
  const { text: out } = await $.command.run(RUN)
  expect(out).toContain('### In Review\n- [PAY-7](https://jira.corp.example/browse/PAY-7) (Bug) Rotate keys')
})

test('falls back to any MCP tool named like a Jira search', async ($, on) => {
  on('tool.list', async () => tools('mcp__claude_ai_Gmail__search_threads', 'mcp__corp_jira__searchJiraTickets'))
  on('mcp.call', async (_$, e) => {
    expect(`${e.server}/${e.tool}`).toBe('corp_jira/searchJiraTickets')
    expect(Object.keys(e.args)).toEqual(['jql'])
    return text({ issues: [{ key: 'PAY-1', url: 'https://jira.corp.example/browse/PAY-1', fields: { summary: 'Hi', status: { name: 'To Do' } } }] })
  })
  const { text: out } = await $.command.run(RUN)
  expect(out).toContain('- [PAY-1](https://jira.corp.example/browse/PAY-1) (Task) Hi')
})

test('says what it looked for when no Jira server is connected', async ($, on) => {
  on('tool.list', async () => tools('Read', 'mcp__claude_ai_Gmail__create_draft'))
  const { text: out } = await $.command.run(RUN)
  expect(out).toContain("Couldn't load Jira tasks: no Jira MCP server connected")
})

test('draws the card when the row text carries the plugin name first', async $ => {
  const ui = await $.ui.mount({
    plugin: 'jira-tasks', surface: 'terminal', component: 'CommandOutput',
    props: { command: 'jira', args: '', text: 'jira-tasks: Jira · 1 open · 09:05\n### To Do\n- KAN-1 (Task) Task 1', isErrored: false },
  })
  expect(await ui.find({ key: 'row-KAN-1' })).toBeDefined()
})

test('cuts a long summary with an ellipsis', async $ => {
  const long = 'Migrate the payment service to the new ledger API and backfill three years of settlement records'
  const ui = await $.ui.mount({
    plugin: 'jira-tasks', surface: 'terminal', component: 'CommandOutput',
    props: { command: 'jira', args: '', text: `Jira · 1 open · 09:05\n### To Do\n- KAN-9 (Story) ${long}`, isErrored: false },
  })
  const shown = await ui.find({ type: 'Text', text: /^Migrate the payment/ })
  expect(shown?.text).toMatch(/…$/)
})

test('reports a server failure as text', async ($, on) => {
  on('tool.list', async () => tools('mcp__a__searchJiraIssuesUsingJql'))
  on('mcp.call', async () => ({ value: { content: [{ type: 'text' as const, text: 'Unauthorized' }], isError: true } }))
  const { text: out } = await $.command.run(RUN)
  expect(out).toBe("Couldn't load Jira tasks: Unauthorized")
})

const EVIDENCE = (key: string, summary: string) => ({
  id: key.slice(4),
  key,
  fields: {
    summary,
    status: { name: 'In Review', statusCategory: { name: 'In Progress' } },
    priority: { name: 'Medium' },
    issuetype: { id: '10007', name: 'Subtask' },
    parent: { key: 'KAN-7', fields: { summary: 'Parent' } },
  },
})

test('asks for the evidence view and merges pages by following nextPageToken', async ($, on) => {
  on('tool.list', async () => tools('mcp__a__searchJiraIssuesUsingJql'))
  const searches: Record<string, unknown>[] = []
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'getAccessibleAtlassianResources') return text({ data: { resources: [{ cloudId: 'c1', url: 'https://x.atlassian.net' }] } })
    searches.push(e.args)
    if (!e.args.nextPageToken) return text({ data: { nextPageToken: 'p2', isLast: false, issues: [EVIDENCE('KAN-11', 'First')] } })
    return text({ data: { isLast: true, issues: [EVIDENCE('KAN-12', 'Second')] } })
  })
  const { text: out } = await $.command.run(RUN)
  expect(searches).toHaveLength(2)
  expect(searches[0]).toMatchObject({ view: 'evidence', maxResults: 25 })
  expect(searches[0]).not.toHaveProperty('nextPageToken')
  expect(searches[1]).toMatchObject({ view: 'evidence', nextPageToken: 'p2' })
  expect(out).toContain('Jira · 2 open')
  expect(out).toContain('[KAN-11](https://x.atlassian.net/browse/KAN-11)')
  expect(out).toContain('[KAN-12](https://x.atlassian.net/browse/KAN-12)')
})

test('says so when the Jira reply is cut off', async ($, on) => {
  on('tool.list', async () => tools('mcp__a__searchJiraIssuesUsingJql'))
  on('mcp.call', async () => ({ value: { content: [{ type: 'text' as const, text: '{"data":{"issues":[{"key":"KAN-1","fi' }], isError: false } }))
  const { text: out } = await $.command.run(RUN)
  expect(out).toBe("Couldn't load Jira tasks: the Jira reply was cut off or not JSON (37 chars)")
})
