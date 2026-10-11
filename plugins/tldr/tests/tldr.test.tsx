import { expect, mock, test } from 'claude-code/testing'
import { normalize } from '../hooks/register'

const long = Array.from({ length: 20 }, (_, i) => `line ${i} of a long answer`).join('\n')
const REPLY = 'LAYOUT: WORK\n✓ Refactored the parser\n✓ verified: mvn test: 11 pass\n- Tests were skipped\n● Pick a migration strategy'

function setup($: any, on: any, _unused: unknown) {
  const clock = mock.clock(on)
  on('turn.start', async (_$: any, e: any) => ({ turnId: e.turnId }))
  mock.store(on)
  on('turn.complete', async (_$: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', async (_$: any, e: any) => ({ text: e.text }) as any)
  on('ui.render', async (u: any, e: any) => {
    const { Text } = u.ui.resolve(e)
    return <Text>base</Text>
  })
  return { clock }
}

const done = (over: Record<string, unknown> = {}) =>
  ({ answer: long, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...over }) as any

const CARD = '"borderColor":"magenta"'

const band = ($: any, text = long) =>
  $.ui.mount({ plugin: 'tldr', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true } } as any)

const modelReturns = (on: any, r: any) => on('model.complete', async () => ({ value: r }) as any)

test('short answer shows no card', async ($, on) => {
  setup($, on, null)
  await $.turn.complete(done({ answer: 'ok' }))
  const ui = await band($)
  expect(JSON.stringify(await ui.drawn())).not.toContain(CARD)
})

test('the card needs 12 non-empty lines or 1200 characters', async ($, on) => {
  const { clock } = setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  const shows = async (answer: string) => {
    await $.turn.complete(done({ answer }))
    await clock.settle()
    return JSON.stringify(await (await band($, answer)).drawn()).includes(CARD)
  }
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line number ${i} of the answer`).join('\n')
  expect(await shows(lines(11))).toBe(false)
  expect(await shows(`${lines(11)}\n\n\n`)).toBe(false)
  expect(await shows(lines(12))).toBe(true)
  expect(await shows('x'.repeat(1199))).toBe(false)
  expect(await shows('x'.repeat(1200))).toBe(true)
})

test('long work answer shows the parsed lines', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  const ui = await band($)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain(CARD)
  expect(drawn).toContain('"children":["✓"]')
  expect(drawn).toContain('Refactored the parser')
  expect(drawn).toContain('verified: mvn test: 11 pass')
  expect(drawn).toContain('"color":"green"')
  expect(drawn.indexOf('Refactored')).toBeLessThan(drawn.indexOf('verified'))
  expect(drawn).toContain('● Pick a migration strategy')
  expect(drawn).toContain('"children":["·"]')
  expect(drawn).toContain('Tests were skipped')
  expect(drawn).not.toContain('lines →')
  expect(drawn.indexOf('● Pick')).toBeLessThan(drawn.indexOf('Refactored'))
})

test('subagent turn is ignored', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done({ agentId: 'sub1' }))
  expect(JSON.stringify(await (await band($)).drawn())).not.toContain(CARD)
})

test('the next prompt keeps the card of the past answer', async ($, on) => {
  const { clock } = setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  await clock.settle()
  await $.prompt.submit({ text: 'next' } as any)
  expect(JSON.stringify(await (await band($)).drawn())).toContain(CARD)
})

test('failed model call shows nothing', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: false, reason: 'error' })
  await $.turn.complete(done())
  expect(JSON.stringify(await (await band($)).drawn())).not.toContain(CARD)
})

test('/tldr off skips the automatic summary and bare /tldr still summarizes', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  const off = await $.command.run({ command: 'tldr', args: 'off' } as any)
  expect(off.text).toContain('off')
  await $.turn.complete(done())
  expect(JSON.stringify(await (await band($)).drawn())).not.toContain(CARD)
  const r = await $.command.run({ command: 'tldr', args: '' } as any)
  expect(r.text).toContain('Pick a migration strategy')
  expect(r.text).toContain('LAYOUT: WORK')
})

test('/tldr output renders as the card', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  const r = await $.command.run({ command: 'tldr', args: '' } as any)
  const out = await $.ui.mount({ plugin: 'tldr', surface: 'terminal', component: 'CommandOutput', props: { command: 'tldr', text: r.text } } as any)
  const drawn = JSON.stringify(await out.drawn())
  expect(drawn).toContain('"borderColor":"magenta"')
  expect(drawn).toContain('● Pick a migration strategy')
  expect(drawn).toContain('mvn test: 11 pass')
})

test('a check draws green and a cross draws red', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: 'LAYOUT: WORK\n✓ built it\n✗ verified: mvn test: 2 failed\n○ docs not updated' })
  await $.turn.complete(done())
  const drawn = JSON.stringify(await (await band($)).drawn())
  expect(drawn).toContain('"props":{"bold":true,"color":"green"},"children":["✓"]')
  expect(drawn).toContain('"props":{"bold":true,"color":"red"},"children":["✗"]')
  expect(drawn).toContain('mvn test: 2 failed')
  expect(drawn).toContain('docs not updated')
})

test('card has a magenta border, a green check and no dismiss button', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  const drawn = JSON.stringify(await (await band($)).drawn())
  expect(drawn).toContain('"borderColor":"magenta"')
  expect(drawn).toContain('"props":{"bold":true,"color":"green"},"children":["✓"]')
  expect(drawn).not.toContain('✕')
})

test('card fills the transcript width', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  expect(JSON.stringify(await (await band($)).drawn())).toContain('"width":"100%"')
})

test('a long NEEDS YOU line is rendered in full', async ($, on) => {
  setup($, on, null)
  const text = ('Decide '.repeat(43) + 'x').slice(0, 300).trim()
  modelReturns(on, { isAnswered: true, text: `LAYOUT: WORK\n✓ x\n● ${text}` })
  await $.turn.complete(done())
  const drawn = JSON.stringify(await (await band($)).drawn())
  expect(drawn).toContain(text)
  expect(drawn).not.toContain('…')
})

const block = ($: any, text: string, over: Record<string, unknown> = {}) =>
  $.ui.mount({ plugin: 'tldr', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true, ...over } } as any)

const first = Array.from({ length: 10 }, (_, i) => `line ${i} of a long answer`).join('\n')
const second = Array.from({ length: 10 }, (_, i) => `line ${i + 10} of a long answer`).join('\n')

const setView = ($: any, args: string) => $.command.run({ command: 'tldr', args } as any)

const footer = ($: any, modes: string[] = []) =>
  $.ui.mount({ plugin: 'tldr', surface: 'terminal', component: 'SessionMode', props: { modes } } as any)

const startSession = ($: any, on: any) => {
  on('command.register', async (_$: any, e: any) => ({ value: { command: e.name } }) as any)
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  return $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
}

const segments = (drawn: string) => ({
  off: drawn.includes('"label":"off"'),
  full: drawn.includes('"label":"full"'),
  tldr: drawn.includes('"label":"TL;DR"'),
})

test('the footer shows all three segments in every mode, the active one shaded, and a press switches', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  let ui = await footer($, ['focus'])
  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('focus')
  expect(segments(drawn)).toEqual({ off: true, full: false, tldr: true })
  await $.turn.complete(done())
  await ui.press({ key: 'view-tldr' })
  ui = await footer($)
  expect(segments(JSON.stringify(await ui.drawn()))).toEqual({ off: true, full: true, tldr: false })
  await ui.press({ key: 'view-off' })
  ui = await footer($)
  expect(segments(JSON.stringify(await ui.drawn()))).toEqual({ off: false, full: true, tldr: true })
  await ui.press({ key: 'view-full' })
  expect(segments(JSON.stringify(await (await footer($)).drawn()))).toEqual({ off: true, full: false, tldr: true })
})

test('/tldr off, full, only and on set the mode', async ($, on) => {
  setup($, on, null)
  const mode = async () => segments(JSON.stringify(await (await footer($)).drawn()))
  await setView($, 'only')
  expect(await mode()).toEqual({ off: true, full: true, tldr: false })
  await setView($, 'off')
  expect(await mode()).toEqual({ off: false, full: true, tldr: true })
  await setView($, 'full')
  expect(await mode()).toEqual({ off: true, full: false, tldr: true })
  await setView($, 'only')
  await setView($, 'on')
  expect(await mode()).toEqual({ off: true, full: false, tldr: true })
})

test('the mode starts as full without options', async ($, on) => {
  setup($, on, null)
  await startSession($, on)
  expect(segments(JSON.stringify(await (await footer($)).drawn()))).toEqual({ off: true, full: false, tldr: true })
})

test('defaultView tldr starts in TL;DR only', { options: { defaultView: 'tldr' } }, async ($, on) => {
  setup($, on, null)
  await startSession($, on)
  expect(segments(JSON.stringify(await (await footer($)).drawn()))).toEqual({ off: true, full: true, tldr: false })
})

test('defaultView off starts off: no summary call, card, band or plan, but /tldr works', { options: { defaultView: 'off' } }, async ($, on) => {
  setup($, on, null)
  tools(on)
  let calls = 0
  on('model.complete', async () => {
    calls++
    return { value: { isAnswered: true, text: REPLY } } as any
  })
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }) as any)
  await startSession($, on)
  expect(segments(JSON.stringify(await (await footer($)).drawn()))).toEqual({ off: false, full: true, tldr: true })
  await $.turn.start({ text: 'go', turnId: 't1' } as any)
  await $.tool.call({ tool: 'TodoWrite', todos: todos('in_progress') } as any)
  const working = await text(await wband($))
  expect(working).toContain('base')
  expect(working).not.toContain(CARD)
  await $.turn.complete(done())
  expect(calls).toBe(0)
  const drawn = await text(await block($, long))
  expect(drawn).toContain('base')
  expect(drawn).not.toContain(CARD)
  expect(drawn).not.toContain('summarizing…')
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: ['TodoWrite'], outputStyle: null, traits: [] } as any)
  expect(composed.sections.find((s: any) => s.id === 'tldr:plan')).toBeUndefined()
  const r = await $.command.run({ command: 'tldr', args: '' } as any)
  expect(calls).toBe(1)
  expect(r.text).toContain('Pick a migration strategy')
  const out = await $.ui.mount({ plugin: 'tldr', surface: 'terminal', component: 'CommandOutput', props: { command: 'tldr', text: r.text } } as any)
  expect(JSON.stringify(await out.drawn())).toContain(CARD)
  expect(await text(await block($, long))).not.toContain(CARD)
})

test('tldr view folds the first block of a summarized answer and hides the rest', async ($, on) => {
  const { clock } = setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  await clock.settle()
  await setView($, 'only')
  const drawn = JSON.stringify(await (await block($, first)).drawn())
  expect(drawn).toContain('● ▸ answer folded (20 lines) · TL;DR below · /tldr full to show')
  expect(drawn).not.toContain('TL;DR"')
  expect(drawn).not.toContain('base')
  const later = JSON.stringify(await (await block($, second, { isFirstOfReply: false })).drawn())
  expect(later).not.toContain('folded')
  expect(later).not.toContain('base')
  expect(later).toContain('Refactored the parser')
})

test('full view: the last block draws the text plus the card, earlier blocks draw normally', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  const early = JSON.stringify(await (await block($, first)).drawn())
  expect(early).toContain('base')
  expect(early).not.toContain(CARD)
  const last = JSON.stringify(await (await block($, second, { isFirstOfReply: false })).drawn())
  expect(last).toContain('base')
  expect(last).toContain('Refactored the parser')
  expect(last.indexOf('base')).toBeLessThan(last.indexOf(CARD))
})

test('two answers each keep their own card', async ($, on) => {
  setup($, on, null)
  let n = 0
  on('model.complete', async () => ({ value: { isAnswered: true, text: `LAYOUT: ANSWER\noutcome ${++n}` } }) as any)
  const other = long.replaceAll('line', 'row')
  await $.turn.complete(done())
  await $.turn.complete(done({ answer: other, turnId: 't2' }))
  const a = JSON.stringify(await (await block($, long)).drawn())
  const b = JSON.stringify(await (await block($, other)).drawn())
  expect(a).toContain('outcome 1')
  expect(a).not.toContain('outcome 2')
  expect(b).toContain('outcome 2')
  expect(b).not.toContain('outcome 1')
})

test('pending summary shows summarizing… under the last block only', async ($, on) => {
  setup($, on, null)
  on('model.complete', () => new Promise(() => {}))
  await $.turn.complete(done())
  const early = JSON.stringify(await (await block($, first)).drawn())
  expect(early).not.toContain('summarizing…')
  const last = JSON.stringify(await (await block($, second, { isFirstOfReply: false })).drawn())
  expect(last).toContain('base')
  expect(last).toContain('summarizing…')
  expect(last).not.toContain(CARD)
})

test('/tldr refreshes the inline card of the last answer', async ($, on) => {
  setup($, on, null)
  let reply = REPLY
  on('model.complete', async () => ({ value: { isAnswered: true, text: reply } }) as any)
  await $.turn.complete(done())
  reply = 'LAYOUT: ANSWER\nSecond take'
  await $.command.run({ command: 'tldr', args: '' } as any)
  const drawn = JSON.stringify(await (await block($, long)).drawn())
  expect(drawn).toContain('Second take')
  expect(drawn).not.toContain('Refactored the parser')
})

test('full view draws the message normally', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  expect(JSON.stringify(await (await block($, long)).drawn())).toContain('base')
})

test('unsummarized, short and summary blocks are never folded', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  await setView($, 'only')
  const other = 'a different reply that was never summarized by this plugin at all'
  expect(JSON.stringify(await (await block($, other)).drawn())).toContain('base')
  expect(JSON.stringify(await (await block($, 'line 1 of a long answer')).drawn())).toContain('base')
  expect(JSON.stringify(await (await block($, long, { isSummary: true })).drawn())).toContain('base')
})

test('a failed summary means no fold', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: false, reason: 'error' })
  await $.turn.complete(done())
  await setView($, 'only')
  expect(JSON.stringify(await (await block($, long)).drawn())).toContain('base')
})

const wband = ($: any, over: Record<string, unknown> = {}) =>
  $.ui.mount({ plugin: 'tldr', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, bodyColumns: 80, ...over } } as any)

const text = async (ui: any) => JSON.stringify(await ui.drawn())

function tools(on: any) {
  on('tool.call', async (_$: any, e: any) => {
    const result = e.tool === 'TaskCreate' ? { task: { id: String(++taskId), subject: e.subject } } : e.tool === 'TaskUpdate' ? { success: true } : 'ok'
    return { result, ref: 'r', text: '' } as any
  })
}
let taskId = 0

const startTurn = async ($: any, on: any, model: unknown = { isAnswered: true, text: REPLY }, prompt = 'Build the weather dashboard\nwith charts') => {
  const { clock } = setup($, on, null)
  on('model.complete', typeof model === 'function' ? (model as any) : async () => ({ value: model }) as any)
  tools(on)
  taskId = 0
  await $.command.run({ command: 'tldr', args: 'only' } as any)
  await $.prompt.submit({ text: prompt } as any)
  await $.turn.start({ text: prompt, turnId: 't1' } as any)
  return clock
}

const todos = (...s: string[]) => s.map((status, i) => ({ content: `Step ${i + 1} task`, status, activeForm: 'Doing' }))

test('tldr mode: TodoWrite shows step 3 of 4 with no bar on the step line', async ($, on) => {
  await startTurn($, on)
  await $.tool.call({ tool: 'TodoWrite', todos: todos('completed', 'completed', 'in_progress', 'pending') } as any)
  const drawn = await text(await wband($))
  expect(drawn).toContain('Step 3 of 4')
  expect(drawn).not.toContain('50%')
  expect(drawn).not.toContain('━')
  expect(['Build','the','weather','dashboard'].every(w => drawn.includes(`"${w}"`))).toBe(true)
  expect(drawn).not.toContain('with charts')
  expect(drawn).toContain('Working')
  expect(drawn).toContain('Next')
  expect(drawn).toContain('"borderColor":"magenta"')
})

test('TaskCreate and TaskUpdate progress is counted', async ($, on) => {
  await startTurn($, on)
  for (const subject of ['a', 'b', 'c', 'd']) await $.tool.call({ tool: 'TaskCreate', subject, description: subject } as any)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as any)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' } as any)
  const drawn = await text(await wband($))
  expect(drawn).toContain('Step 2 of 4')
  expect(drawn).not.toContain('25%')
  await $.tool.call({ tool: 'TaskUpdate', taskId: '4', status: 'deleted' } as any)
  expect(await text(await wband($))).toContain('Step 2 of 3')
})

test('more than 6 steps shows +N more', async ($, on) => {
  await startTurn($, on)
  await $.tool.call({ tool: 'TodoWrite', todos: todos(...Array(9).fill('pending')) } as any)
  expect(await text(await wband($))).toContain('+3 more')
})

test('no task list: each tool call is a step, marked done when it returns', async ($, on) => {
  await startTurn($, on)
  await $.tool.call({ tool: 'Read', file_path: 'src/Foo.java' } as any)
  await $.tool.call({ tool: 'Bash', command: 'mvn test\necho done' } as any)
  const drawn = await text(await wband($))
  expect(drawn).toContain('Reading Foo.java')
  expect(drawn).toContain('Running mvn test')
  expect(drawn).not.toContain('Understanding your request')
  expect(drawn.match(/"Done"/g)?.length).toBe(2)
  expect(drawn).not.toContain('Step 1 of')
  expect(drawn).not.toContain('2 steps ·')
})

test('a shell step reads its description, not the command', async ($, on) => {
  await startTurn($, on)
  await $.tool.call({ tool: 'Bash', command: 'find . -name "*.ts" | xargs grep -l foo', description: 'Find files that use foo' } as any)
  const drawn = await text(await wband($))
  expect(drawn).toContain('Find files that use foo')
  expect(drawn).not.toContain('xargs')
})

test('no task list: only the latest calls are listed, the rest counted', async ($, on) => {
  await startTurn($, on)
  for (let i = 0; i < 8; i++) await $.tool.call({ tool: 'Read', file_path: `f${i}.txt` } as any)
  const drawn = await text(await wband($))
  expect(drawn).toContain('+2 earlier')
  expect(drawn).not.toContain('f1.txt')
  expect(drawn).toContain('f7.txt')
})

test('subagent tool calls do not count', async ($, on) => {
  await startTurn($, on)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'sub1' } as any)
  await $.tool.call({ tool: 'TodoWrite', todos: todos('pending'), agentId: 'sub1' } as any)
  const drawn = await text(await wband($))
  expect(drawn).toContain('Understanding your request')
  expect(drawn).toContain('"Step 1"')
  expect(drawn).not.toContain('Running ls')
  expect(drawn).not.toContain('Step 1 of')
})

test('spinner and timer advance with the clock, and stop after turn.complete', async ($, on) => {
  const { clock } = setup($, on, null)
  tools(on)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.command.run({ command: 'tldr', args: 'only' } as any)
  await $.turn.start({ text: 'go', turnId: 't1' } as any)
  expect(await text(await wband($))).toContain('⠋')
  await clock.advance(1000)
  const drawn = await text(await wband($))
  expect(drawn).toContain('1s')
  expect(drawn).toContain('⠼')
  await clock.advance(4000)
  expect(await text(await wband($))).toContain('5s')
  await $.turn.complete(done({ answer: 'ok', durationMs: 107000 }))
  await clock.advance(5000)
  const strip = (t: string) => t.replace(/"handle":\d+/g, '')
  const idle = strip(await text(await wband($, { isWorking: false })))
  expect(idle).toContain('base')
  expect(idle).not.toContain('took')
})

test('tldr view: a single-block answer shows the fold line, then the card with the time', async ($, on) => {
  const clock = await startTurn($, on)
  await $.tool.call({ tool: 'TodoWrite', todos: todos('completed', 'in_progress') } as any)
  await $.turn.complete(done({ durationMs: 107000 }))
  await clock.settle()
  const drawn = await text(await block($, long))
  expect(drawn).toContain('▸ answer folded (20 lines)')
  expect(drawn).toContain('1m 47s')
  expect(drawn).toContain('Refactored the parser')
  expect(drawn).not.toContain('All done')
  expect(drawn).not.toContain('base')
  expect(drawn.indexOf('folded')).toBeLessThan(drawn.indexOf(CARD))
})

test('the card shows the steps from tool calls in order, repeats collapsed, with the time top right', async ($, on) => {
  const clock = await startTurn($, on)
  await $.tool.call({ tool: 'Read', file_path: 'src/Foo.java' } as any)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'mvn test', description: 'Running the tests' } as any)
  await $.tool.call({ tool: 'Read', file_path: 'src/Bar.java' } as any)
  await $.turn.complete(done({ durationMs: 107000 }))
  await clock.settle()
  for (const args of ['only', 'full']) {
    await setView($, args)
    const drawn = await text(await block($, long))
    expect(drawn).toContain('Steps: Reading Foo.java › Running the tests ×3 › Reading Bar.java')
    expect(drawn).toContain('1m 47s')
    expect(drawn).not.toContain('lines →')
    expect(drawn).not.toContain('All done')
  }
})

test('a task list names the steps instead of the tool calls', async ($, on) => {
  const clock = await startTurn($, on)
  await $.tool.call({ tool: 'TodoWrite', todos: todos('completed', 'in_progress') } as any)
  await $.tool.call({ tool: 'Read', file_path: 'src/Foo.java' } as any)
  await $.turn.complete(done())
  await clock.settle()
  const drawn = await text(await block($, long))
  expect(drawn).toContain('Steps: Step 1 task › Step 2 task')
  expect(drawn).not.toContain('Reading Foo.java')
})

test('a card with no steps draws no steps line', async ($, on) => {
  const clock = await startTurn($, on)
  await $.turn.complete(done())
  await clock.settle()
  expect(await text(await block($, long))).not.toContain('Steps:')
})

test('work layout draws needs first, then the lines, then the Steps line', async ($, on) => {
  const clock = await startTurn($, on)
  await $.tool.call({ tool: 'Read', file_path: 'src/Foo.java' } as any)
  await $.turn.complete(done())
  await clock.settle()
  const drawn = await text(await block($, long))
  expect(drawn.indexOf('● Pick a migration strategy')).toBeLessThan(drawn.indexOf('Refactored the parser'))
  expect(drawn.indexOf('Refactored the parser')).toBeLessThan(drawn.indexOf('mvn test: 11 pass'))
  expect(drawn.indexOf('mvn test: 11 pass')).toBeLessThan(drawn.indexOf('Tests were skipped'))
  expect(drawn.indexOf('Tests were skipped')).toBeLessThan(drawn.indexOf('Steps: Reading Foo.java'))
})

test('many long steps are cut to one line ending with +N more', async ($, on) => {
  const clock = await startTurn($, on)
  for (let i = 0; i < 10; i++) {
    await $.tool.call({ tool: 'Bash', command: 'x', description: `Checking the configuration of module number ${i}` } as any)
  }
  await $.turn.complete(done())
  await clock.settle()
  const drawn = await text(await block($, long, { bodyColumns: 100 }))
  const line = JSON.parse(drawn.match(/"(Steps: [^"]*)"/)![0])
  expect(line.length).toBeLessThanOrEqual(94)
  expect(line).toContain('Checking the configuration of module number 0')
  expect(line).toMatch(/ › \+\d+ more$/)
  expect(line).not.toContain('number 9')
})

test('a new prompt mid-session restarts the steps of the next card', async ($, on) => {
  const clock = await startTurn($, on)
  await $.tool.call({ tool: 'Read', file_path: 'src/Old.java' } as any)
  await $.prompt.submit({ text: 'something else' } as any)
  await $.tool.call({ tool: 'Read', file_path: 'src/New.java' } as any)
  await $.turn.complete(done())
  await clock.settle()
  const drawn = await text(await block($, long))
  expect(drawn).toContain('Steps: Reading New.java')
  expect(drawn).not.toContain('Old.java')
})

test('AbovePrompt draws nothing of its own when idle or finished, in both modes', async ($, on) => {
  const { clock } = setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  for (const args of ['only', 'full']) {
    await setView($, args)
    expect(await text(await wband($, { isWorking: false }))).toContain('base')
  }
  await $.turn.complete(done({ durationMs: 107000 }))
  await clock.settle()
  for (const args of ['only', 'full']) {
    await setView($, args)
    const after = await text(await wband($, { isWorking: false }))
    expect(after).toContain('base')
    expect(after).not.toContain(CARD)
    expect(after).not.toContain('All done')
  }
})

test('aborted and errored turns hand the slot back', async ($, on) => {
  await startTurn($, on)
  await $.turn.complete(done({ reason: 'aborted', isAborted: true }))
  expect(await text(await wband($, { isWorking: false }))).toContain('base')
  await $.turn.start({ text: 'again', turnId: 't2' } as any)
  await $.turn.complete(done({ reason: 'error' }))
  expect(await text(await wband($, { isWorking: false }))).toContain('base')
})

test('tldr view draws the progress band while working', async ($, on) => {
  await startTurn($, on)
  const drawn = await text(await wband($))
  expect(drawn).not.toContain('base')
  expect(drawn).toContain('"borderColor":"magenta"')
  expect(drawn).toContain('Working')
})

test('full mode keeps today\'s band while working', async ($, on) => {
  setup($, on, null)
  tools(on)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.start({ text: 'go', turnId: 't1' } as any)
  await $.tool.call({ tool: 'TodoWrite', todos: todos('completed', 'pending') } as any)
  const drawn = await text(await wband($))
  expect(drawn).toContain('base')
  expect(drawn).not.toContain('Step')
  await $.turn.complete(done())
  const after = await text(await wband($, { isWorking: false }))
  expect(after).toContain('base')
  expect(after).not.toContain(CARD)
})


test('tldr view asks for a short task list up front; full view adds nothing', async ($, on) => {
  setup($, on, null)
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }) as any)
  const plan = async (tools: string[]) =>
    (await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools, outputStyle: null, traits: [] } as any)).sections.find((s: any) => s.id === 'tldr:plan')
  expect(await plan(['TodoWrite', 'Bash'])).toBeUndefined()
  await $.command.run({ command: 'tldr', args: 'only' } as any)
  const added = await plan(['TodoWrite', 'Bash'])
  expect(added?.scope).toBe('session')
  expect(added?.text).toContain('first tool call is TodoWrite')
  expect(added?.text).toContain('3 to 7 steps')
  expect((await plan(['TaskCreate', 'TaskUpdate']))?.text).toContain('first tool call is TaskCreate')
  expect(await plan(['Bash'])).toBeUndefined()
  await $.command.run({ command: 'tldr', args: 'full' } as any)
  expect(await plan(['TodoWrite'])).toBeUndefined()
})

const ANSWER_REPLY = 'LAYOUT: ANSWER\n**Yes, it is thread safe**\n- Uses a `ReentrantLock` around writes\n- Reads are lock free\n● Confirm the Java version'
const TABLE_REPLY = 'LAYOUT: TABLE\nTwo of three modules pass\n| Module | Status |\n|---|---|\n| core | **pass** |\n| api | fail |\n● Fix api'

test('answer layout: bold headline, bullets, needs last, no Steps line', async ($, on) => {
  const clock = await startTurn($, on, { isAnswered: true, text: ANSWER_REPLY })
  await $.tool.call({ tool: 'Read', file_path: 'src/Foo.java' } as any)
  await $.turn.complete(done())
  await clock.settle()
  const drawn = await text(await block($, long))
  expect(drawn).toContain('"props":{"bold":true},"children":[{"type":"Text","props":{"bold":true},"children":["Yes, it is thread safe"]}')
  expect(drawn).toContain('"children":["·"]')
  expect(drawn).toContain('"color":"cyan"')
  expect(drawn).toContain('ReentrantLock')
  expect(drawn).toContain('Reads are lock free')
  expect(drawn).not.toContain('Steps:')
  expect(drawn.indexOf('Yes, it is')).toBeLessThan(drawn.indexOf('Reads are lock free'))
  expect(drawn.indexOf('Reads are lock free')).toBeLessThan(drawn.indexOf('● Confirm the Java version'))
})

test('table layout: header, cells, rule, no separator row, table after the headline', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: TABLE_REPLY })
  await $.turn.complete(done())
  const drawn = JSON.stringify(await (await band($)).drawn())
  expect(drawn).toContain('"bold":true,"color":"magenta"')
  expect(drawn).toContain('Module')
  expect(drawn).toContain('core')
  expect(drawn).toContain('pass')
  expect(drawn).not.toContain('**')
  expect(drawn).not.toContain('---')
  expect(drawn).toContain('────')
  expect(drawn.indexOf('Two of three')).toBeLessThan(drawn.indexOf('Module'))
  expect(drawn.indexOf('api')).toBeLessThan(drawn.indexOf('● Fix api'))
})

test('table layout: columns and rows are capped and the table fits the width', async ($, on) => {
  setup($, on, null)
  const wide = 'w'.repeat(60)
  const rows = Array.from({ length: 10 }, (_, r) => `| r${r} | ${wide} | c | d | e |`)
  modelReturns(on, { isAnswered: true, text: `LAYOUT: TABLE\nbig\n| h0 | h1 | h2 | h3 | h4 |\n|---|---|---|---|---|\n${rows.join('\n')}` })
  await $.turn.complete(done())
  const drawn = JSON.stringify(await (await block($, long, { bodyColumns: 50 })).drawn())
  expect(drawn).toContain('h3')
  expect(drawn).not.toContain('h4')
  expect(drawn).toContain('r5')
  expect(drawn).not.toContain('r6')
  const rule = drawn.match(/"(─+)"/)![1]!
  expect(rule.length).toBeLessThanOrEqual(44)
  expect(drawn).not.toContain(wide)
  expect(drawn).toContain('…')
})

test('the model receives the request and the answer', async ($, on) => {
  const seen: any[] = []
  const clock = setup($, on, null).clock
  on('model.complete', async (_$: any, e: any) => {
    seen.push(e)
    return { value: { isAnswered: true, text: ANSWER_REPLY } } as any
  })
  await $.prompt.submit({ text: 'Is it thread safe?' } as any)
  await $.turn.start({ text: 'Is it thread safe?', turnId: 't1' } as any)
  await $.turn.complete(done())
  await clock.settle()
  expect(seen).toHaveLength(1)
  expect(seen[0].system).toContain('LAYOUT: ANSWER|TABLE|STEPS|WORK')
  expect(seen[0].maxTokens).toBe(700)
  expect(seen[0].prompt).toBe(`REQUEST:\nIs it thread safe?\n\nANSWER:\n${long}`)
  await $.command.run({ command: 'tldr', args: '' } as any)
  expect(seen).toHaveLength(2)
  expect(seen[1].prompt).toContain('REQUEST:\nIs it thread safe?')
})

test('an old-format record is normalized into a work summary', () => {
  const old = { done: 'Old outcome', verified: 'mvn test: 3 pass', needs: ['Old question'], notes: ['Old note'], lines: 20 }
  expect(normalize(old)).toEqual({
    layout: 'work',
    body: ['✓ Old outcome', '✓ verified: mvn test: 3 pass', '- Old note'],
    table: null,
    needs: ['Old question'],
    lines: 20,
  })
  expect(normalize({ done: '', verified: '', needs: [], notes: [], lines: 1 }).body).toEqual([])
  const current = { layout: 'answer', body: ['x'], table: null, needs: [], lines: 1 }
  expect(normalize(current)).toBe(current)
})

test('/tldr output round-trips into the same card, table included', async ($, on) => {
  const clock = setup($, on, null).clock
  modelReturns(on, { isAnswered: true, text: TABLE_REPLY })
  await $.turn.complete(done())
  await clock.settle()
  const inline = JSON.stringify(await (await band($)).drawn())
  const r = await $.command.run({ command: 'tldr', args: '' } as any)
  expect(r.text).toContain('| Module | Status |\n| --- | --- |\n| core | pass |')
  const out = await $.ui.mount({ plugin: 'tldr', surface: 'terminal', component: 'CommandOutput', props: { command: 'tldr', text: r.text } } as any)
  const body = (t: string) => t.slice(t.indexOf('Two of three'), t.indexOf('Fix api'))
  expect(body(JSON.stringify(await out.drawn()))).toBe(body(inline))
})

test('a missing LAYOUT line defaults to answer, or table when a table is present', async ($, on) => {
  setup($, on, null)
  let reply = 'Just the answer\n- a fact'
  on('model.complete', async () => ({ value: { isAnswered: true, text: reply } }) as any)
  await $.turn.complete(done())
  await $.command.run({ command: 'tldr', args: '' } as any)
  expect((await $.command.run({ command: 'tldr', args: '' } as any)).text).toContain('LAYOUT: ANSWER')
  reply = 'Verdict\n| a | b |\n| 1 | 2 |'
  expect((await $.command.run({ command: 'tldr', args: '' } as any)).text).toContain('LAYOUT: TABLE')
  reply = 'layout: steps\n1. do `x`'
  expect((await $.command.run({ command: 'tldr', args: '' } as any)).text).toContain('LAYOUT: STEPS')
})

test('fenced output, headings and a TL;DR label are cleaned up', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: '```\nLAYOUT: STEPS\n# Heading\n**TL;DR:**\nInstall it\n1. Run `npm i`\n2. Run `npm test`\n```' })
  await $.turn.complete(done())
  const drawn = JSON.stringify(await (await band($)).drawn())
  expect(drawn).toContain('Install it')
  expect(drawn).toContain('"children":["1."]')
  expect(drawn).toContain('npm test')
  expect(drawn).not.toContain('```')
  expect(drawn).not.toContain('Heading')
  expect(drawn).not.toContain('TL;DR:')
})

test('a question line draws `code` in cyan instead of raw backticks', async ($, on) => {
  const { clock } = setup($, on, null)
  modelReturns(on, { isAnswered: true, text: 'LAYOUT: ANSWER\nAll good.\n● Turn it on with `/tldr plan on`?' })
  await $.turn.complete(done())
  await clock.settle()
  const drawn = JSON.stringify(await (await band($)).drawn())
  expect(drawn).toContain('"color":"cyan"},"children":["/tldr plan on"]')
  expect(drawn).not.toContain('`/tldr plan on`')
})
