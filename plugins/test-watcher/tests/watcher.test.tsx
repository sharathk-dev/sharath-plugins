import { expect, mock, test } from 'claude-code/testing'

import * as fx from './fixtures'

let lastId = ''
const SHORT = '[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS\n[INFO] Total time:  0.5 s'
const pad = (n: number) => Array.from({ length: n }, (_, i) => `[INFO] download ${i}`).join('\n')

// Bottom of the chain: stands for the engine. A green or short run answers { stdout, stderr }; a red build exits non-zero,
// which Claude Code reports as an errored call whose result is the error text; the hook answers it with deny.
function setup($: any, on: any, answer: { stdout?: string; error?: string; stderr?: string; failWrite?: boolean }) {
  lastId = ''
  const written: Record<string, string> = {}
  mock.clock(on, { now: Date.UTC(2026, 9, 10, 12, 0, 0) })
  mock.env(on, { HOME: '/home/u' })
  on('fs.write', async (_$: any, e: any) => {
    if (answer.failWrite) throw new Error('disk full')
    written[e.path] = e.text
    return { value: undefined } as any
  })
  on('tool.call', async (_$: any, e: any) =>
    (lastId = e.tool_use_id, answer.error !== undefined
      ? { isError: true, result: answer.error, text: answer.error }
      : { result: { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', interrupted: false }, text: answer.stdout ?? '' }) as any,
  )
  return written
}

const call = ($: any, command: string) => $.tool.call({ tool: 'Bash', command })

test('a long failing run: stdout becomes the compact text and the log is written', async ($, on) => {
  const written = setup($, on, { error: `Exit code 1\n${pad(30)}\n${fx.mavenFail}` })
  const r = await call($, 'cd app && mvn test')
  const paths = Object.keys(written)
  expect(paths.length).toBe(1)
  const path = paths[0]!
  expect(path).toMatch(/^\/home\/u\/\.cache\/test-watcher\/2026-10-10T12-00-00-000Z-.+\.log$/)
  expect(written[path]).toContain('BUILD FAILURE')
  expect(written[path]).toContain('download 29')
  const text = r.deny as string
  expect(text.split('\n')[0]).toBe('Exit code 1')
  expect(text).toContain('mvn test: FAILED · 2 failed, 2 passed, 1 skipped · 0.8s')
  expect(text).toContain('✗ CalculatorTest.addsTwoNumbers (CalculatorTest.java:13): expected: <5> but was: <1>')
  expect(text).toContain(`Full log: ${path}`)
  expect(text).not.toContain('at org.junit')
  expect(r.result).toBeUndefined()
})

test('a long green run: stdout replaced, stderr emptied, other fields kept', async ($, on) => {
  const written = setup($, on, { stdout: `${pad(30)}\n${fx.mavenPass}`, stderr: 'WARNING: noise' })
  const r: any = await call($, 'mvn verify')
  const path = Object.keys(written)[0]!
  expect(written[path]).toContain('WARNING: noise')
  expect(r.result.stdout).toBe(`mvn verify: PASSED · 3 passed, 1 skipped · 0.8s\nFull log: ${path}  (read it if you need more detail)`)
  expect(r.result.stderr).toBe('')
  expect(r.result.interrupted).toBe(false)
})

test('a long gradle failure is compacted too', async ($, on) => {
  setup($, on, { error: `Exit code 1\n${fx.gradleFail}` })
  const r = await call($, './gradlew test')
  expect(r.deny).toContain('gradle test: FAILED · 2 failed, 1 passed, 1 skipped · 2.0s')
  expect(r.deny).toContain('✗ CalculatorTest.add (CalculatorTest.java:14): expected: <5> but was: <-1>')
})

test('short output passes through unchanged, but the card still gets its summary', async ($, on) => {
  const written = setup($, on, { stdout: SHORT })
  const r: any = await call($, 'mvn test')
  expect(r.result.stdout).toBe(SHORT)
  expect(Object.keys(written)).toEqual([])
  const ui = await card($, on)
  expect(JSON.stringify(await ui.drawn())).toContain('✓ 2 passed · 0.5s')
  expect(JSON.stringify(await ui.drawn())).not.toContain('full log')
})

test('unparseable output passes through unchanged and gets no card', async ($, on) => {
  on('ui.render', async (u: any, e: any) => {
    const { Text } = u.ui.resolve(e)
    return <Text>base</Text>
  })
  const noise = pad(60)
  const written = setup($, on, { stdout: noise })
  const r: any = await call($, 'mvn test')
  expect(r.result.stdout).toBe(noise)
  expect(Object.keys(written)).toEqual([])
  const ui = await $.ui.mount({ plugin: 'test-watcher', surface: 'terminal', component: 'ToolResult', requestId: lastId, props: { tool_use_id: lastId, tool: 'Bash', output: {}, isErrored: false } })
  expect(JSON.stringify(await ui.drawn())).toContain('base')
})

test('a command that is not a test run is untouched', async ($, on) => {
  const out = `${pad(30)}\n${fx.mavenFail}`
  const written = setup($, on, { stdout: out })
  for (const cmd of ['grep mvn pom.xml', 'mvn -DskipTests package']) {
    const r: any = await call($, cmd)
    expect(r.result.stdout).toBe(out)
  }
  expect(Object.keys(written)).toEqual([])
})

test('a log that cannot be written leaves the result alone', async ($, on) => {
  const out = `${pad(30)}\n${fx.mavenPass}`
  setup($, on, { stdout: out, failWrite: true })
  const r: any = await call($, 'mvn test')
  expect(r.result.stdout).toBe(out)
})

const logEntry = (name: string, mtimeMs: number, kind = 'file') => ({ name, kind, size: 1, mtimeMs, isLink: false })

test('after writing a log, only the newest 50 *.log files are kept', async ($, on) => {
  const dir = '/home/u/.cache/test-watcher'
  const old = Array.from({ length: 52 }, (_, i) => logEntry(`old-${i}.log`, 1000 + i))
  const listed = [...old, logEntry('notes.txt', 1), logEntry('sub', 1, 'dir')]
  const rm: string[][] = []
  setup($, on, { stdout: `${pad(30)}\n${fx.mavenPass}` })
  on('fs.list', async (_$: any, e: any) => ({ value: e.path === dir ? listed : [] }) as any)
  on('process.run', async (_$: any, e: any) => (rm.push(e.argv), { value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
  await call($, 'mvn test')
  expect(rm.length).toBe(1)
  expect(rm[0]!.slice(0, 3)).toEqual(['rm', '-f', '--'])
  expect(rm[0]!.slice(3).sort()).toEqual([`${dir}/old-0.log`, `${dir}/old-1.log`])
})

test('a pruning failure does not touch the result', async ($, on) => {
  const out = `${pad(30)}\n${fx.mavenPass}`
  setup($, on, { stdout: out })
  on('fs.list', async () => {
    throw new Error('unreadable')
  })
  const r: any = await call($, 'mvn test')
  expect(r.result.stdout).toContain('mvn test: PASSED')
})

const baseRow = (on: any) =>
  on('ui.render', async (u: any, e: any) => {
    const { Text } = u.ui.resolve(e)
    return <Text>base row</Text>
  })

const card = async ($: any, _on: any, over: Record<string, unknown> = {}) =>
 $.ui.mount({ plugin: 'test-watcher', surface: 'terminal', component: 'ToolUse', requestId: lastId, props: { tool_use_id: lastId, tool: 'Bash', input: { command: 'mvn test' }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: 'engine inline', stderr: '' }, ...over } })

test('card for a failing run: header, rows, log line', async ($, on) => {
  setup($, on, { error: `Exit code 1\n${pad(30)}\n${fx.mavenFail}` })
  await call($, 'mvn test')
  const drawn = JSON.stringify(await (await card($, on)).drawn())
  expect(drawn).toContain('mvn test')
  expect(drawn).toContain('✗ 2 failed · 2 passed · 1 skipped · 0.8s')
  expect(drawn).toContain('"color":"red"')
  expect(drawn).toContain('✗ CalculatorTest.addsTwoNumbers')
  expect(drawn).toContain('CalculatorTest.java:13')
  expect(drawn).toContain('expected: <5> but was: <1>')
  expect(drawn).toContain('✗ BoomTest.explodes')
  expect(drawn).toContain('full log: ')
})

test('card for a green run is green', async ($, on) => {
  setup($, on, { stdout: `${pad(30)}\n${fx.mavenPass}` })
  await call($, 'mvn test')
  const drawn = JSON.stringify(await (await card($, on)).drawn())
  expect(drawn).toContain('✓ 3 passed · 0.8s')
  expect(drawn).toContain('"color":"green"')
  expect(drawn).not.toContain('✗')
})

test('card for a build error', async ($, on) => {
  setup($, on, { error: `Exit code 1\n${pad(30)}\n${fx.mavenCompileError}` })
  await call($, 'mvn test')
  const drawn = JSON.stringify(await (await card($, on)).drawn())
  expect(drawn).toContain('✗ build error')
  expect(drawn).toContain('Calculator.java:10: cannot find symbol')
})

test('card caps the failure rows at 8 and says how many more', async ($, on) => {
  const many = Array.from({ length: 11 }, (_, i) => `[ERROR]   T${i}.t:${i + 1} boom ${i}`).join('\n')
  const out = `${pad(30)}\n[ERROR] Failures: \n${many}\n[ERROR] Tests run: 11, Failures: 11, Errors: 0, Skipped: 0\n[INFO] BUILD FAILURE`
  setup($, on, { error: `Exit code 1\n${out}` })
  await call($, 'mvn test')
  const drawn = JSON.stringify(await (await card($, on)).drawn())
  expect(drawn).toContain('✗ T7.t')
  expect(drawn).not.toContain('✗ T8.t')
  expect(drawn).toContain('+3 more')
})

test('other results are drawn by the engine, not the card', async ($, on) => {
  setup($, on, { stdout: 'x' })
  on('ui.render', async (u: any, e: any) => {
    const { Text } = u.ui.resolve(e)
    return <Text>base</Text>
  })
  const ui = await $.ui.mount({ plugin: 'test-watcher', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: 'nope', tool: 'Bash', output: {}, isErrored: false } })
  expect(JSON.stringify(await ui.drawn())).toContain('base')
})

const group = (calls: any[]) =>
  ({ plugin: 'test-watcher', surface: 'terminal', component: 'ToolGroup', props: { calls, isActive: false, isExpanded: false } }) as any

const bashCall = (id: string, over: Record<string, unknown> = {}) => ({ tool_use_id: id, tool: 'Bash', input: { command: 'mvn test' }, isRunning: false, isErrored: false, isInterrupted: false, ...over })

const row = ($: any, id: string, over: Record<string, unknown> = {}) =>
  $.ui.mount({ plugin: 'test-watcher', surface: 'terminal', component: 'ToolUse', requestId: id, props: { tool_use_id: id, tool: 'Bash', input: { command: 'mvn test' }, isRunning: false, isErrored: false, isInterrupted: false, ...over } })

test('a group holding a recorded call is expanded', async ($, on) => {
  setup($, on, { stdout: SHORT })
  const seen: boolean[] = []
  on('ui.render', async (u: any, e: any) => {
    const { Text } = u.ui.resolve(e)
    seen.push(e.props.isExpanded)
    return <Text>base</Text>
  })
  await call($, 'mvn test')
  await $.ui.mount(group([bashCall('other'), bashCall(lastId)]))
  expect(seen).toEqual([true])
})

test('a group without a recorded call is untouched', async ($, on) => {
  setup($, on, { stdout: SHORT })
  const seen: boolean[] = []
  on('ui.render', async (u: any, e: any) => {
    const { Text } = u.ui.resolve(e)
    seen.push(e.props.isExpanded)
    return <Text>base</Text>
  })
  await call($, 'mvn test')
  await $.ui.mount(group([bashCall('other')]))
  expect(seen).toEqual([false])
})

test('a recorded call that is still running does not unfold the group', async ($, on) => {
  setup($, on, { stdout: SHORT })
  const seen: boolean[] = []
  on('ui.render', async (u: any, e: any) => {
    const { Text } = u.ui.resolve(e)
    seen.push(e.props.isExpanded)
    return <Text>base</Text>
  })
  await call($, 'mvn test')
  await $.ui.mount(group([bashCall(lastId, { isRunning: true })]))
  expect(seen).toEqual([false])
})

test('a ToolUse row with a recorded id is drawn whole, with the summary under the header', async ($, on) => {
  setup($, on, { stdout: SHORT })
  baseRow(on)
  await call($, 'mvn test')
  const drawn = JSON.stringify(await (await row($, lastId)).drawn())
  expect(drawn).not.toContain('base row')
  expect(drawn.indexOf('Bash(mvn test)')).toBeLessThan(drawn.indexOf('✓ 2 passed'))
})

test('an errored recorded call still shows the card', async ($, on) => {
  setup($, on, { error: `Exit code 1\n${pad(30)}\n${fx.mavenFail}` })
  baseRow(on)
  await call($, 'mvn test')
  const drawn = JSON.stringify(await (await row($, lastId, { isErrored: true })).drawn())
  expect(drawn).toContain('"color":"red"')
  expect(drawn).toContain('✗ 2 failed · 2 passed · 1 skipped · 0.8s')
})

test('a ToolUse row without a recorded id is the engine row', async ($, on) => {
  setup($, on, { stdout: 'x' })
  baseRow(on)
  const drawn = JSON.stringify(await (await row($, 'nope')).drawn())
  expect(drawn).toContain('base row')
  expect(drawn).not.toContain('passed')
})

test('the row is drawn whole: header, gutter, no engine output', async ($, on) => {
  setup($, on, { stdout: SHORT })
  const seen: unknown[] = []
  on('ui.render', async (u: any, e: any) => {
    const { Text } = u.ui.resolve(e)
    seen.push(e.props.output)
    return <Text>engine row</Text>
  })
  await call($, 'mvn test')
  const drawn = JSON.stringify(await (await row($, lastId, { output: { stdout: 'mvn test: PASSED', stderr: '' } })).drawn())
  expect(drawn).toContain(' Bash(mvn test)')
  expect(drawn).toContain('  ⎿ ')
  expect(drawn).toContain('✓ 2 passed · 0.5s')
  expect(drawn).not.toContain('PASSED')
  expect(drawn).not.toContain('engine row')
  expect(drawn).not.toContain('borderStyle')
  expect(seen).toEqual([])
})

test('an errored row does not repeat the engine error text', async ($, on) => {
  setup($, on, { error: `Exit code 1\n${pad(30)}\n${fx.mavenFail}` })
  baseRow(on)
  await call($, 'mvn test')
  const drawn = JSON.stringify(await (await row($, lastId, { isErrored: true, output: 'Error: mvn test: FAILED' })).drawn())
  expect(drawn).not.toContain('Error: mvn test')
  expect(drawn).toContain('✗ 2 failed · 2 passed')
})

test('lines are clipped to the viewport', async ($, on) => {
  setup($, on, { error: `Exit code 1\n${pad(30)}\n${fx.mavenFail}` })
  baseRow(on)
  await call($, 'mvn test')
  const ui = await $.ui.mount({ plugin: 'test-watcher', surface: 'terminal', component: 'ToolUse', requestId: lastId, viewport: { columns: 40, rows: 40 }, props: { tool_use_id: lastId, tool: 'Bash', input: { command: 'mvn test' }, isRunning: false, isErrored: true, isInterrupted: false } } as any)
  expect(JSON.stringify(await ui.drawn())).toMatch(/full log: [^"]*…"/)
})

test('the log path is not clipped at a wide viewport', async ($, on) => {
  setup($, on, { stdout: `${pad(30)}\n${fx.mavenPass}` })
  await call($, 'mvn test')
  const ui = await $.ui.mount({ plugin: 'test-watcher', surface: 'terminal', component: 'ToolUse', requestId: lastId, viewport: { columns: 200, rows: 40 }, props: { tool_use_id: lastId, tool: 'Bash', input: { command: 'mvn test' }, isRunning: false, isErrored: false, isInterrupted: false } } as any)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toMatch(/full log: [^"]*test-watcher\/[^"]*\.log"/)
  expect(drawn).not.toContain('…')
})

test('the ToolResult of a recorded call draws nothing, since the row owns the card', async ($, on) => {
  setup($, on, { stdout: SHORT })
  baseRow(on)
  await call($, 'mvn test')
  const ui = await $.ui.mount({ plugin: 'test-watcher', surface: 'terminal', component: 'ToolResult', requestId: lastId, props: { tool_use_id: lastId, tool: 'Bash', output: {}, isErrored: false } })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('passed')
  expect(drawn).not.toContain('base row')
})
