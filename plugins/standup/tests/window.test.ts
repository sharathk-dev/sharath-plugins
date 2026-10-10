import { expect, test } from 'claude-code/testing'
import { draftOf, fromText, jiraJql, jqlDate, parseArgs, toText, windowFor } from '../hooks/standup'
import type { Report, Spec } from '../hooks/standup'

const LAST: Spec = { kind: 'last' }
const YESTERDAY: Spec = { kind: 'yesterday' }
// 2026-10-12 is a Monday. Local time, so the tests hold in any time zone.
const at = (day: number, h = 10) => new Date(2026, 9, day, h, 30)
const from = (w: { from: Date }) => jqlDate(w.from)

test('default window: Sunday covers Saturday and Sunday so far', async () => {
  const now = at(11)
  const w = windowFor(now, LAST)
  expect(from(w)).toBe('2026-10-10 00:00')
  expect(w.to.getTime()).toBe(now.getTime())
  expect(w.label).toBe('Sat 10 – Sun 11 Oct')
  expect(w.word).toBe('Since yesterday')
})

test('default window: Saturday covers Friday and Saturday so far', async () => {
  const w = windowFor(at(10), LAST)
  expect(from(w)).toBe('2026-10-09 00:00')
  expect(w.label).toBe('Fri 9 – Sat 10 Oct')
})

test('default window: Monday starts from Friday so the weekend is included', async () => {
  const now = at(12)
  const w = windowFor(now, LAST)
  expect(from(w)).toBe('2026-10-09 00:00')
  expect(w.to.getTime()).toBe(now.getTime())
  expect(w.label).toBe('Fri 9 – Mon 12 Oct')
  expect(w.word).toBe('Since Friday')
})

test('default window: Tuesday covers Monday and Tuesday so far', async () => {
  const w = windowFor(at(13), LAST)
  expect(from(w)).toBe('2026-10-12 00:00')
  expect(w.label).toBe('Mon 12 – Tue 13 Oct')
  expect(w.word).toBe('Since yesterday')
})

test('default window labels both months when it crosses a month boundary', async () => {
  const w = windowFor(new Date(2026, 10, 2, 9), LAST)
  expect(from(w)).toBe('2026-10-30 00:00')
  expect(w.label).toBe('Fri 30 Oct – Mon 2 Nov')
})

test('yesterday: the calendar day before today, weekends included', async () => {
  const sunday = windowFor(at(11), YESTERDAY)
  expect(sunday.label).toBe('Sat 10 Oct')
  expect(sunday.word).toBe('Yesterday')
  expect([jqlDate(sunday.from), jqlDate(sunday.to)]).toEqual(['2026-10-10 00:00', '2026-10-11 00:00'])
  const monday = windowFor(at(12), YESTERDAY)
  expect(monday.label).toBe('Sun 11 Oct')
  expect([jqlDate(monday.from), jqlDate(monday.to)]).toEqual(['2026-10-11 00:00', '2026-10-12 00:00'])
})

test('today runs from midnight to now', async () => {
  const now = at(10, 22)
  const w = windowFor(now, { kind: 'today' })
  expect(w.label).toBe('Sat 10 Oct (today)')
  expect(w.from.getTime()).toBe(new Date(2026, 9, 10).getTime())
  expect(w.to.getTime()).toBe(now.getTime())
})

test('3d runs from midnight three days ago to now', async () => {
  const now = at(12)
  const w = windowFor(now, { kind: 'days', days: 3 })
  expect(jqlDate(w.from)).toBe('2026-10-09 00:00')
  expect(w.to.getTime()).toBe(now.getTime())
  expect(w.label).toBe('last 3 days, Fri 9 Oct - Mon 12 Oct')
})

test('args: none, today, Nd, and rejects the rest', async () => {
  expect(parseArgs('')).toEqual({ kind: 'last' })
  expect(parseArgs('  ')).toEqual({ kind: 'last' })
  expect(parseArgs('today')).toEqual({ kind: 'today' })
  expect(parseArgs('Yesterday')).toEqual({ kind: 'yesterday' })
  expect(parseArgs('Today ')).toEqual({ kind: 'today' })
  expect(parseArgs('3d')).toEqual({ kind: 'days', days: 3 })
  expect(parseArgs('14d')).toEqual({ kind: 'days', days: 14 })
  expect('error' in (parseArgs('0d') as object)).toBe(true)
  expect('error' in (parseArgs('week') as object)).toBe(true)
})

test('JQL covers the window for tickets I moved myself', async () => {
  expect(jiraJql(windowFor(at(12), LAST))).toBe('status CHANGED BY currentUser() DURING ("2026-10-09 00:00", "2026-10-12 10:30") ORDER BY updated DESC')
  const jql = jiraJql(windowFor(at(11), YESTERDAY))
  expect(jql).toContain('DURING ("2026-10-10 00:00", "2026-10-11 00:00")')
  expect(jql).not.toContain('assignee')
})

const report: Report = {
  label: 'Fri 9 – Mon 12 Oct', word: 'Since Friday', jiraDown: false,
  commits: [{ repo: 'web', count: 3, messages: ['Add modulo', 'Fix a · b'] }, { repo: 'api', count: 1, messages: [] }],
  prs: [{ kind: 'merged', repo: 'web', number: 2, url: 'https://github.com/o/web/pull/2', title: 'Docs' }],
  jira: [{ key: 'KAN-3', url: 'https://jira.example.com/browse/KAN-3', summary: 'Login page', status: 'In Review', category: 'In Progress' }],
}

test('text form round-trips and the draft is plain text', async () => {
  const text = toText(report)
  expect(text).toBe([
    'Standup · Fri 9 – Mon 12 Oct · {Since Friday}',
    '### Commits (4)',
    '- web (3): Add modulo · Fix a - b',
    '- api (1): ',
    '### PRs',
    '- merged [web#2](https://github.com/o/web/pull/2) Docs',
    '### Jira',
    '- [KAN-3](https://jira.example.com/browse/KAN-3) Login page · In Review/In Progress',
  ].join('\n'))
  const back = fromText(text)!
  expect(back.commits.map(c => [c.repo, c.count, c.messages.length])).toEqual([['web', 3, 2], ['api', 1, 0]])
  expect(back.prs[0]).toEqual(report.prs[0])
  expect(back.jira[0]).toEqual(report.jira[0])
  expect(draftOf(back)).toBe([
    'Since Friday:',
    '- 4 commits in web, api (Add modulo; Fix a - b)',
    '- Merged web#2 Docs',
    '- KAN-3 Login page -> In Review',
    '',
    'Today: continue KAN-3 Login page',
    'Blockers: none',
  ].join('\n'))
})

test('empty report is one line that reads back', async () => {
  const text = toText({ ...report, commits: [], prs: [], jira: [], jiraDown: true })
  expect(text).toBe('Nothing found for Fri 9 – Mon 12 Oct · Jira unavailable')
  expect(fromText(text)).toMatchObject({ label: 'Fri 9 – Mon 12 Oct', jiraDown: true, commits: [] })
})

test('reads back the row text the transcript stores under the plugin name', async () => {
  expect(fromText(`standup: ${toText(report)}`)).toMatchObject({ label: report.label, prs: [{ number: report.prs[0]!.number }] })
})
