import { expect, mock, test } from 'claude-code/testing'

const long = Array.from({ length: 20 }, (_, i) => `line ${i} of a long answer`).join('\n')
const REPLY = 'DONE: Refactored the parser\nVERIFIED: mvn test: 11 pass\nNEEDS YOU: Pick a migration strategy\nNOTE: Tests were skipped\nJUNK: ignored'

function setup($: any, on: any, _unused: unknown, writes?: Record<string, unknown>) {
  const clock = mock.clock(on)
  on('turn.start', async (_$: any, e: any) => ({ turnId: e.turnId }))
  if (writes) {
    on('store.get', async (_$: any, e: any) => ({ value: writes[e.key] }) as any)
    on('store.set', async (_$: any, e: any) => {
      writes[e.key] = e.value
      return { value: undefined } as any
    })
  } else mock.store(on)
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

test('long answer shows parsed DONE / NEEDS YOU / NOTE', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done())
  const ui = await band($)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain(CARD)
  expect(drawn).toContain('"children":["✓"]')
  expect(drawn).toContain('Refactored the parser')
  expect(drawn).toContain('"children":["✔︎ verified:"]')
  expect(drawn).toContain('mvn test: 11 pass')
  expect(drawn).toContain('"color":"green"')
  expect(drawn.indexOf('✓')).toBeLessThan(drawn.indexOf('verified'))
  expect(drawn.indexOf('verified')).toBeLessThan(drawn.indexOf('● Pick'))
  expect(drawn).toContain('● Pick a migration strategy')
  expect(drawn).toContain('"children":["·"]')
  expect(drawn).toContain('Tests were skipped')
  expect(drawn).not.toContain('ignored')
  expect(drawn).toContain('20 lines → 4')
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

test('/tldr off persists and /tldr summarizes the last answer', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  const off = await $.command.run({ command: 'tldr', args: 'off' } as any)
  expect(off.text).toContain('off')
  await $.turn.complete(done())
  expect(JSON.stringify(await (await band($)).drawn())).not.toContain(CARD)
  const r = await $.command.run({ command: 'tldr', args: '' } as any)
  expect(r.text).toContain('Pick a migration strategy')
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
  expect(drawn).toContain('"props":{"dimColor":true},"children":["✔︎ verified:"]')
  expect(drawn).not.toContain('"color":"red"')
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
  modelReturns(on, { isAnswered: true, text: `DONE: x\nNEEDS YOU: ${text}` })
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

test('the footer shows both views, the active one shaded, and a press on the other switches', async ($, on) => {
  const writes: Record<string, unknown> = {}
  setup($, on, null, writes)
  modelReturns(on, { isAnswered: true, text: REPLY })
  expect(JSON.stringify(await (await footer($)).drawn())).not.toContain('"label":"TL;DR"')
  await $.turn.complete(done())
  expect(JSON.stringify(await (await band($)).drawn())).not.toContain('"label":"TL;DR"')
  let ui = await footer($, ['focus'])
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('focus')
  expect(drawn).toContain('"label":"TL;DR"')
  expect(drawn).not.toContain('"label":"full"')
  await ui.press({ key: 'view-tldr' })
  expect(writes.view).toBe('tldr')
  ui = await footer($)
  expect(JSON.stringify(await ui.drawn())).toContain('"label":"full"')
  await ui.press({ key: 'view-full' })
  expect(writes.view).toBe('full')
})

test('/tldr only and /tldr full set the view', async ($, on) => {
  const writes: Record<string, unknown> = {}
  setup($, on, null, writes)
  await setView($, 'only')
  expect(writes.view).toBe('tldr')
  await setView($, 'full')
  expect(writes.view).toBe('full')
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
  on('model.complete', async () => ({ value: { isAnswered: true, text: `DONE: outcome ${++n}` } }) as any)
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
  reply = 'DONE: Second take'
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

test('tldr view: a single-block answer shows the fold line, then the card with the done header', async ($, on) => {
  const clock = await startTurn($, on)
  await $.tool.call({ tool: 'TodoWrite', todos: todos('completed', 'in_progress') } as any)
  await $.turn.complete(done({ durationMs: 107000 }))
  await clock.settle()
  const drawn = await text(await block($, long))
  expect(drawn).toContain('▸ answer folded (20 lines)')
  expect(drawn).toContain('✓ All done · took 1m 47s')
  expect(drawn).toContain('Refactored the parser')
  expect(drawn).not.toContain('base')
  expect(drawn.indexOf('folded')).toBeLessThan(drawn.indexOf(CARD))
  expect(drawn.indexOf(CARD)).toBeLessThan(drawn.indexOf('All done'))
})

test('the done header is left out of the card in full view', async ($, on) => {
  setup($, on, null)
  modelReturns(on, { isAnswered: true, text: REPLY })
  await $.turn.complete(done({ durationMs: 107000 }))
  expect(await text(await block($, long))).not.toContain('All done')
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
