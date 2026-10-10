import { expect, mock, test } from 'claude-code/testing'

const long = Array.from({ length: 20 }, (_, i) => `line ${i} of a long answer`).join('\n')
const REPLY = 'DONE: Refactored the parser\nVERIFIED: mvn test: 11 pass\nNEEDS YOU: Pick a migration strategy\nNOTE: Tests were skipped\nJUNK: ignored'

function setup($: any, on: any, _unused: unknown) {
  mock.clock(on)
  mock.store(on)
  on('turn.complete', async (_$: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', async (_$: any, e: any) => ({ text: e.text }) as any)
  on('ui.render', async (u: any, e: any) => {
    const { Text } = u.ui.resolve(e)
    return <Text>base</Text>
  })
  return {}
}

const done = (over: Record<string, unknown> = {}) =>
  ({ answer: long, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...over }) as any

const band = ($: any) =>
  $.ui.mount({ plugin: 'tldr', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } })

const modelReturns = (on: any, r: any) => on('model.complete', async () => ({ value: r }) as any)

test('short answer shows no band', async ($, on) => {
  setup($, on, null)
  await $.turn.complete(done({ answer: 'ok' }))
  const ui = await band($)
  expect(JSON.stringify(await ui.drawn())).not.toContain('TL;DR')
})

test('the band needs 10 non-empty lines or 800 characters', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  const shows = async (answer: string) => {
    await $.turn.complete(done({ answer }))
    return JSON.stringify(await (await band($)).drawn()).includes('TL;DR')
  }
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n')
  expect(await shows(lines(9))).toBe(false)
  expect(await shows(`${lines(9)}\n\n\n`)).toBe(false)
  expect(await shows(lines(10))).toBe(true)
  expect(await shows('x'.repeat(799))).toBe(false)
  expect(await shows('x'.repeat(800))).toBe(true)
})

test('long answer shows parsed DONE / NEEDS YOU / NOTE', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  const ui = await band($)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('TL;DR')
  expect(drawn).toContain('✓ Refactored the parser')
  expect(drawn).toContain('✔︎ verified: mvn test: 11 pass')
  expect(drawn).toContain('"color":"green"')
  expect(drawn.indexOf('✓ ')).toBeLessThan(drawn.indexOf('verified'))
  expect(drawn.indexOf('verified')).toBeLessThan(drawn.indexOf('● Pick'))
  expect(drawn).toContain('● Pick a migration strategy')
  expect(drawn).toContain('· Tests were skipped')
  expect(drawn).not.toContain('ignored')
  expect(drawn).toContain('20 lines → 4')
})

test('subagent turn is ignored', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done({ agentId: 'sub1' }))
  expect(JSON.stringify(await (await band($)).drawn())).not.toContain('TL;DR')
})

test('prompt.submit clears the band', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  expect(JSON.stringify(await (await band($)).drawn())).toContain('TL;DR')
  await $.prompt.submit({ text: 'next' } as any)
  expect(JSON.stringify(await (await band($)).drawn())).not.toContain('TL;DR')
})

test('failed model call shows nothing', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: false, reason: 'error' })
  await $.turn.complete(done())
  expect(JSON.stringify(await (await band($)).drawn())).not.toContain('TL;DR')
})

test('/tldr off persists and /tldr summarizes the last answer', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  const off = await $.command.run({ command: 'tldr', args: 'off' } as any)
  expect(off.text).toContain('off')
  await $.turn.complete(done())
  expect(JSON.stringify(await (await band($)).drawn())).not.toContain('TL;DR')
  const r = await $.command.run({ command: 'tldr', args: '' } as any)
  expect(r.text).toContain('Pick a migration strategy')
})

test('dismiss button clears the band', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  const ui = await band($)
  await ui.press({ key: 'dismiss' })
  expect(JSON.stringify(await (await band($)).drawn())).not.toContain('TL;DR')
})

test('failed verification renders red', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: 'DONE: x\nVERIFIED: mvn test: 2 failed' })
  await $.turn.complete(done())
  expect(JSON.stringify(await (await band($)).drawn())).toContain('"color":"red"')
})

test('mixed pass and fail renders yellow', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: 'DONE: x\nVERIFIED: mvn test: 2 passed on main; 1 failed + 2 passed on scratch copy.' })
  await $.turn.complete(done())
  const drawn = JSON.stringify(await (await band($)).drawn())
  expect(drawn).toContain('"color":"yellow"')
  expect(drawn).not.toContain('"color":"red"')
})

test('only passes renders green, and 0 failed does not turn it red', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: 'DONE: x\nVERIFIED: mvn test: 11 passed, 0 failed' })
  await $.turn.complete(done())
  expect(JSON.stringify(await (await band($)).drawn())).toContain('"color":"green"')
})

test('not run renders dim, not red or green', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: 'DONE: x\nVERIFIED: not run' })
  await $.turn.complete(done())
  const drawn = JSON.stringify(await (await band($)).drawn())
  expect(drawn).toContain('verified: not run')
  expect(drawn).not.toContain('"color"')
})

test('card is 100 wide in a 120-column viewport, whatever bodyColumns says', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  const ui = await $.ui.mount({ plugin: 'tldr', surface: 'terminal', component: 'AbovePrompt', viewport: { columns: 120, rows: 40 }, props: { hasSurvey: false, isWorking: false, bodyColumns: 70 } } as any)
  expect(JSON.stringify(await ui.drawn())).toContain('"width":100')
})
