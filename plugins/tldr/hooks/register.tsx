import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { Entry, Progress, Summary } from '../types'

const records = atom({ plugin: 'tldr', key: 'records' } as const, [])
const pending = atom({ plugin: 'tldr', key: 'pending' } as const, '')
const lastAnswer = atom({ plugin: 'tldr', key: 'lastAnswer' } as const, '')
const epoch = atom({ plugin: 'tldr', key: 'epoch' } as const, 0)
const view = atom({ plugin: 'tldr', key: 'view' } as const, 'full')
const phase = atom({ plugin: 'tldr', key: 'phase' } as const, 'idle')
const prompt = atom({ plugin: 'tldr', key: 'prompt' } as const, '')
const steps = atom({ plugin: 'tldr', key: 'steps' } as const, [])
const stepCount = atom({ plugin: 'tldr', key: 'stepCount' } as const, 0)
const calls = atom({ plugin: 'tldr', key: 'calls' } as const, [])
const activity = atom({ plugin: 'tldr', key: 'activity' } as const, '')
const pulse = atom({ plugin: 'tldr', key: 'pulse' } as const, { tick: 0, elapsedMs: 0 })

const MIN_LINES = 12
const MIN_CHARS = 1200
const CARD_WIDTH = 100
const MIN_BLOCK = 40
const KEEP = 20
const LIMITS = { done: 1, needs: 3, notes: 2 }
const TICK_MS = 250
const SPINNER = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏']
const MAX_ROWS = 6
const MINI_W = 8
const STATUS_W = 8
const PINK = '#ff5fa2'
const TRACK = '#3a3a3a'
const GREY = '#6b7280'
const TRAIL = ['#4a2040', '#7a2a60', '#b03a8a', '#d946ef', '#f0abfc']
const GRADIENT = [
  [255, 95, 162],
  [217, 70, 239],
  [96, 165, 250],
]
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])

type Step = { id: string | null; text: string; status: 'pending' | 'in_progress' | 'completed' }

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

function firstLine(text: string): string {
  return text.split('\n').find(l => l.trim() !== '')?.trim() ?? ''
}

function gradientColor(i: number, n: number): string {
  const pos = (n <= 1 ? 0 : i / (n - 1)) * (GRADIENT.length - 1)
  const k = Math.min(GRADIENT.length - 2, Math.floor(pos))
  const mix = GRADIENT[k]!.map((c, j) => Math.round(c + (GRADIENT[k + 1]![j]! - c) * (pos - k)))
  return `#${mix.map(c => c.toString(16).padStart(2, '0')).join('')}`
}

function describeCall(e: any): string {
  const one = (v: unknown) => firstLine(String(v ?? ''))
  const file = (v: unknown) => one(v).split('/').pop() || one(v)
  switch (e.tool) {
    case 'Bash': return one(e.description) || `Running ${one(e.command)}`
    case 'Read': return `Reading ${file(e.file_path)}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return `Editing ${file(e.file_path ?? e.notebook_path)}`
    case 'Write': return `Writing ${file(e.file_path)}`
    case 'Grep': return `Searching for "${one(e.pattern)}"`
    case 'Glob': return `Finding files matching ${one(e.pattern)}`
    case 'WebFetch': return `Fetching ${one(e.url)}`
    case 'WebSearch': return `Searching the web for "${one(e.query)}"`
    case 'Agent':
    case 'Task': return one(e.description) || 'Delegating to a subagent'
    case 'Skill': return `Loading the ${one(e.skill)} skill`
    default: return e.tool.startsWith('mcp__') ? `Calling ${e.tool.split('__').pop()}` : `Using ${e.tool}`
  }
}

function currentIndex(list: Step[]): number {
  const i = list.findIndex(s => s.status === 'in_progress')
  return i >= 0 ? i : list.findIndex(s => s.status !== 'completed')
}

function verifiedColor(text: string): string | undefined {
  const t = text.toLowerCase()
  if (/not run/.test(t)) return undefined
  const hasFail = /fail/.test(t) && !/\b0 fail/.test(t)
  const hasPass = /pass|\bok\b/.test(t) && !/\b0 pass/.test(t)
  if (hasFail) return hasPass ? 'yellow' : 'red'
  if (hasPass) return 'green'
  return undefined
}

const SYSTEM = `You write a TL;DR map of an assistant answer for a busy reader. Output STRICT plain text, at most 6 lines in total (in this order), each starting with one of these prefixes:
DONE: <one line: what happened / the outcome> (exactly one line)
VERIFIED: <what the answer says was run or tested, and its outcome> (0 or 1 line, right after DONE). Quote commands, tools and test frameworks exactly as they appear in the answer, e.g. "mvn test: 11 pass". Never invent or substitute a name: if the answer does not name the command, describe it only as the answer does. Omit this line when the answer reports nothing that was run or tested. Write "not run" only when the answer itself says something was not run; never for answers without code changes.
NEEDS YOU: <a question, decision or action the user must take> (0 to 3 lines)
NOTE: <other key fact worth not missing> (0 to 2 lines)
NEEDS YOU is the most important part: never drop questions to the user, things the user must do, failures, errors or warnings.
No markdown, no preamble, no other prefixes. Keep each line short.`

function countLines(text: string): number {
  return text.split('\n').filter(line => line.trim() !== '').length
}

function isLong(text: string): boolean {
  return countLines(text) >= MIN_LINES || text.length >= MIN_CHARS
}

function fromCommandText(text: string): Entry | null {
  const [head, ...rest] = text.split('\n')
  const m = /^TL;DR \((\d+) lines\)$/.exec(head ?? '')
  if (!m) return null
  const summary: Summary = { done: '', verified: '', needs: [], notes: [], lines: Number(m[1]) }
  for (const line of rest) {
    if (line.startsWith('✓ ')) summary.done = line.slice(2)
    else if (line.startsWith('✔︎ verified: ')) summary.verified = line.slice('✔︎ verified: '.length)
    else if (line.startsWith('● ')) summary.needs.push(line.slice(2))
    else if (line.startsWith('· ')) summary.notes.push(line.slice(2))
  }
  return { answer: '', lines: summary.lines, summary, progress: null }
}

function parseSummary(raw: string, lines: number): Summary | null {
  const out: Summary = { done: '', verified: '', needs: [], notes: [], lines }
  for (const line of raw.split('\n')) {
    const m = /^[\s>*\-•#]*\**\s*(DONE|VERIFIED|NEEDS YOU|NOTE)\s*\**\s*:\s*\**\s*(.+?)\s*$/i.exec(line)
    if (!m) continue
    const body = m[2]!.replace(/\*\*|`/g, '')
    const kind = m[1]!.toUpperCase()
    if (kind === 'DONE') {
      if (!out.done) out.done = body
    } else if (kind === 'VERIFIED') {
      if (!out.verified) out.verified = body
    } else if (kind === 'NEEDS YOU') {
      if (out.needs.length < LIMITS.needs) out.needs.push(body)
    } else if (out.notes.length < LIMITS.notes) {
      out.notes.push(body)
    }
  }
  return out.done || out.verified || out.needs.length || out.notes.length ? out : null
}

// Runs the model and stores the result unless a newer turn, prompt or run overtook it. Returns the summary shown, if any.
async function summarize($: any, answer: string, progress: Progress | null = null): Promise<Summary | null> {
  await update($, epoch, n => n + 1)
  const myEpoch = await read($, epoch)
  await update($, pending, () => answer)
  let result: Summary | null = null
  try {
    const r = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 400,
      timeoutMs: 15000,
      system: SYSTEM,
      prompt: `Summarize this answer:\n\n${answer.slice(0, 24000)}`,
    })
    if (r.isAnswered) result = parseSummary(r.text, countLines(answer))
  } catch {
    result = null
  }
  if ((await read($, epoch)) !== myEpoch) return null
  await update($, pending, () => '')
  if (result !== null) {
    const entry = { answer, lines: result.lines, summary: result }
    await update($, records, list => {
      const i = list.findIndex(r => r.answer === answer)
      if (i < 0) return [...list, { ...entry, progress }].slice(-KEEP)
      return list.map((r, j) => (j === i ? { ...entry, progress: progress ?? r.progress } : r))
    })
  }
  return result
}

function planInstruction(tool: string): string {
  return [
    `# Plan before you work`,
    `The person is following your progress in a step list above the prompt, which only shows steps you write down.`,
    `For any request that takes more than one tool call, your first tool call is ${tool}: a plan of 3 to 7 steps, each a few plain words saying what it does ("Reading the parser", "Running the tests").`,
    `Mark each step in progress when you start it and completed as soon as it is done, and add a step if the work turns out bigger than planned.`,
    `Skip the plan for a question you can answer straight away.`,
  ].join('\n')
}

async function setView($: any, mode: 'full' | 'tldr'): Promise<void> {
  await $.store.set('view', mode)
  await update($, view, () => mode)
}

async function resetProgress($: any): Promise<void> {
  await update($, phase, () => 'idle')
  await update($, steps, () => [])
  await update($, stepCount, () => 0)
  await update($, calls, () => [])
  await update($, activity, () => '')
  await update($, pulse, () => ({ tick: 0, elapsedMs: 0 }))
}

async function clear($: any): Promise<void> {
  await update($, epoch, n => n + 1)
  await update($, pending, () => '')
}

const count = (s: Summary) => (s.done ? 1 : 0) + (s.verified ? 1 : 0) + s.needs.length + s.notes.length

function segment($: any, Button: any, Text: any, label: string, target: 'full' | 'tldr', mode: 'full' | 'tldr') {
  if (mode === target) {
    return (
      <Text key={`view-${target}`}>
        {[...label].map((ch, i) => <Text key={i} bold color={gradientColor(i, label.length)}>{ch}</Text>)}
      </Text>
    )
  }
  return <Button key={`view-${target}`} plain dimColor label={label} onPress={() => setView($, target)} />
}

function card($: any, e: any, entry: Entry, mode: 'full' | 'tldr') {
  const { Box, Text } = $.ui.resolve(e)
  const s = entry.summary
  const label = 'TL;DR'
  const notRun = /not run/i.test(s.verified)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} width="100%">
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          {[...label].map((ch, i) => <Text key={i} bold color={gradientColor(i, label.length)}>{ch}</Text>)}
        </Text>
        <Text dimColor>{`${entry.lines} lines → ${count(s)}`}</Text>
      </Box>
      {mode === 'tldr' && entry.progress ? (
        <Text>
          <Text bold color="green">{`✓ All done · took ${formatDuration(entry.progress.tookMs)}`}</Text>
          {entry.progress.steps > 0 ? <Text dimColor>{` · ${entry.progress.steps} steps`}</Text> : null}
        </Text>
      ) : null}
      {s.done ? (
        <Text key="done">
          <Text bold color="green">✓</Text>
          {` ${s.done}`}
        </Text>
      ) : null}
      {s.verified ? (
        <Text key="verified">
          <Text color={verifiedColor(s.verified)} dimColor={notRun}>✔︎ verified:</Text>
          {` ${s.verified}`}
        </Text>
      ) : null}
      {s.needs.map((line, i) => (
        <Text key={`needs-${i}`} bold color="yellow">
          {`● ${line}`}
        </Text>
      ))}
      {s.notes.map((line, i) => (
        <Text key={`note-${i}`}>
          <Text color="cyan">·</Text>
          <Text dimColor>{` ${line}`}</Text>
        </Text>
      ))}
    </Box>
  )
}

export const register: Register = on => {
  let callSeq = 0
  let timer: { cancel: () => void } | undefined
  const stopTimer = () => {
    timer?.cancel()
    timer = undefined
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tldr',
      description:
        'Re-summarize the last long answer; "/tldr on|off" toggles automatic summaries, "/tldr only|full" folds or shows summarized answers',
    })
    if ((await $.store.get('view')) === 'tldr') await update($, view, () => 'tldr')
    // A reload drops any summary or timer still in flight; their flags would otherwise stick.
    await update($, pending, () => '')
    if ((await read($, phase)) === 'working') await update($, phase, () => 'idle')
    return next(e)
  })

  on('command.run', { command: 'tldr' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await $.store.set('auto', arg === 'on')
      return { text: `tldr auto mode ${arg}.` }
    }
    if (arg === 'only' || arg === 'full') {
      await setView($, arg === 'only' ? 'tldr' : 'full')
      return { text: arg === 'only' ? 'tldr: summarized answers are folded; /tldr full shows them.' : 'tldr: showing full answers.' }
    }
    const answer = await read($, lastAnswer)
    if (answer === '') return { text: 'tldr: no long answer to summarize yet.' }
    const s = await summarize($, answer)
    if (s === null) return { text: 'tldr: could not summarize the last answer.' }
    return {
      text: [
        `TL;DR (${s.lines} lines)`,
        s.done && `✓ ${s.done}`,
        s.verified && `✔︎ verified: ${s.verified}`,
        ...s.needs.map(l => `● ${l}`),
        ...s.notes.map(l => `· ${l}`),
      ]
        .filter(Boolean)
        .join('\n'),
    }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'tldr' } }, async ($, e, next) => {
    const entry = fromCommandText(String(e.props.text ?? ''))
    return entry ? card($, e, entry, 'full') : next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if ((await read($, view)) !== 'tldr') return composed
    const tool = e.tools.find(t => t === 'TodoWrite' || t === 'TaskCreate')
    if (tool === undefined) return composed
    return { sections: [...composed.sections, { id: 'tldr:plan', scope: 'session' as const, text: planInstruction(tool) }] }
  })

  on('session.end', async ($, e, next) => {
    stopTimer()
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    stopTimer()
    await update($, epoch, n => n + 1)
    await resetProgress($)
    if (e.text.trim() !== '') await update($, prompt, () => e.text)
    await update($, phase, () => 'working')
    const startedAt = await $.clock.now()
    timer = $.clock.every(TICK_MS, async () => {
      if ((await read($, view)) !== 'tldr') return
      const elapsedMs = (await $.clock.now()) - startedAt
      await update($, pulse, p => ({ tick: p.tick + 1, elapsedMs }))
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await clear($).catch(() => {})
    await resetProgress($).catch(() => {})
    await update($, prompt, () => e.text).catch(() => {})
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || TASK_TOOLS.has(e.tool)) return next(e)
    const id = String(callSeq++)
    await Promise.all([
      update($, stepCount, n => n + 1),
      update($, activity, () => describeCall(e)),
      update($, calls, list => [...list, { id, text: describeCall(e), status: 'in_progress' as const }]),
    ]).catch(() => {})
    try {
      return await next(e)
    } finally {
      await update($, calls, list => list.map(s => (s.id === id ? { ...s, status: 'completed' as const } : s))).catch(() => {})
    }
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && !result.isError) {
      await update($, steps, () => e.todos.map(t => ({ id: null, text: t.content, status: t.status }))).catch(() => {})
    }
    return result
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const result = await next(e)
    const id = (result as any).result?.task?.id
    if (e.agentId === undefined && !result.isError && id !== undefined) {
      await update($, steps, list => [...list, { id: String(id), text: e.subject, status: 'pending' as const }]).catch(() => {})
    }
    return result
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || result.isError || (result as any).result?.success === false) return result
    await update($, steps, list =>
      e.status === 'deleted'
        ? list.filter(s => s.id !== e.taskId)
        : list.map(s => (s.id === e.taskId ? { ...s, text: e.subject ?? s.text, status: e.status ?? s.status } : s)),
    ).catch(() => {})
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      stopTimer()
      await update($, phase, () => (e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'error'))
    }
    if (e.agentId !== undefined || e.reason !== 'answer') return result

    if (!isLong(e.answer)) {
      await update($, lastAnswer, () => '')
      await clear($)
      return result
    }

    await update($, lastAnswer, () => e.answer)
    if ((await $.store.get('auto')) !== false) {
      const list = await read($, steps)
      const progress = { tookMs: e.durationMs, steps: list.length > 0 ? list.length : await read($, stepCount) }
      await update($, pending, () => e.answer)
      void summarize($, e.answer, progress)
    }
    return result
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const block = e.props.text.trim()
    if (block.length < MIN_BLOCK) return next(e)
    const entry = (await read($, records)).findLast(r => r.answer.includes(block))
    const waiting = await read($, pending)
    const isWaiting = !entry && waiting.includes(block)
    if (!entry && !isWaiting) return next(e)

    const answer = entry?.answer ?? waiting
    const isLast = answer.trimEnd().endsWith(block)
    const mode = await read($, view)
    const { Box, Text } = $.ui.resolve(e)
    const tail = !isLast
      ? null
      : entry
        ? card($, e, entry, mode)
        : (
          <Text>
            <Text color="magenta">{SPINNER[0]}</Text>
            <Text dimColor>{' summarizing…'}</Text>
          </Text>
        )

    if (mode === 'tldr' && entry) {
      const isFirst = answer.slice(0, answer.indexOf(block)).trim().length < MIN_BLOCK
      if (!isFirst && !isLast) return <Box />
      const fold = isFirst ? (
        <Text dimColor>
          {`${e.props.isFirstOfReply ? '● ' : ''}▸ answer folded (${entry.lines} lines) · TL;DR below · /tldr full to show`}
        </Text>
      ) : null
      return isLast ? <Box flexDirection="column">{fold}{tail}</Box> : fold
    }
    if (!isLast) return next(e)
    return <Box flexDirection="column">{await next(e)}{tail}</Box>
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if ((await read($, records)).length === 0) return next(e)
    const mode = await read($, view)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        {e.props.modes.length > 0 ? <Text dimColor>{e.props.modes.join(' & ')}</Text> : null}
        <Box flexDirection="row">
          {segment($, Button, Text, 'TL;DR', 'tldr', mode)}
          <Text dimColor>{' · '}</Text>
          {segment($, Button, Text, 'full', 'full', mode)}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, view)) !== 'tldr') return next(e)
    const current = await read($, phase)
    const isLive = current === 'working' || (current === 'idle' && e.props.isWorking)
    if (!isLive) return next(e)

    const width = (e.props.bodyColumns ?? e.viewport?.columns ?? CARD_WIDTH) - 4
    const { Box, Text } = $.ui.resolve(e)

    const list = await read($, steps)
    const callList = await read($, calls)
    const callCount = await read($, stepCount)
    const text = firstLine(await read($, prompt))
    const inner = Math.max(20, width - 4)
    const { tick, elapsedMs } = await read($, pulse)

    const right = formatDuration(elapsedMs)
    const prefix = `${SPINNER[tick % SPINNER.length]} `
    const room = Math.max(1, inner - right.length - prefix.length - 1)
    const words = clip(text, room).split(/(\s+)/)
    const wordCount = words.filter(w => w.trim() !== '').length
    let seen = 0
    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text key="spin" color={PINK}>{prefix}</Text>
          {words.map((w, i) =>
            w.trim() === '' ? w : <Text key={`w${i}`} bold color={gradientColor(seen++, wordCount)}>{w}</Text>,
          )}
        </Text>
        <Text dimColor>{right}</Text>
      </Box>
    )

    const total = list.length
    const completed = list.filter(s => s.status === 'completed').length
    const cur = currentIndex(list)
    const doneCalls = callList.filter(c => c.status === 'completed').length
    const label =
      total > 0
        ? `Step ${Math.min(completed + 1, total)} of ${total}`
        : `Step ${Math.max(1, Math.min(doneCalls + 1, callList.length))}`
    const progress = <Text dimColor>{label}</Text>
    const byCalls = total === 0
    const opening: Step = { id: 'opening', text: 'Understanding your request', status: 'in_progress' }
    const shown = byCalls ? (callList.length > 0 ? callList : [opening]) : list
    const hidden = Math.max(0, shown.length - MAX_ROWS)
    const first = byCalls ? hidden : Math.max(0, Math.min(cur - 2, hidden))
    const longest = Math.max(0, ...shown.slice(first, first + MAX_ROWS).map(s => s.text.length))
    const textW = Math.max(4, Math.min(longest, Math.floor(inner * 0.45), inner - 2 - MINI_W - STATUS_W - 2))
    const trail = (head: number) =>
      [...Array(MINI_W).keys()].map(c => {
        const back = head - c
        const color = back >= 0 && back < TRAIL.length ? TRAIL[TRAIL.length - 1 - back] : TRACK
        return <Text key={`m${c}`} backgroundColor={color}>{' '}</Text>
      })
    const rows = shown.slice(first, first + MAX_ROWS).map((s, i) => {
      const idx = first + i
      const isDoneRow = s.status === 'completed'
      const isCurrent = byCalls ? !isDoneRow : idx === cur
      const status = isDoneRow ? 'Done' : isCurrent ? 'Working' : idx === cur + 1 ? 'Next' : 'Up next'
      const mini = isCurrent ? trail(tick % (MINI_W + TRAIL.length)) : ' '.repeat(MINI_W)
      return (
        <Text key={`step-${idx}`}>
          {isDoneRow ? <Text color="green">{'✓ '}</Text> : isCurrent ? <Text bold>{'● '}</Text> : <Text dimColor>{'○ '}</Text>}
          <Text bold={isCurrent} color={isCurrent ? 'white' : undefined} dimColor={!isCurrent}>
            {clip(s.text, textW).padEnd(textW)}
          </Text>
          {' '}
          {mini}
          {' '}
          {isDoneRow ? (
            <Text color="green">{status}</Text>
          ) : isCurrent ? (
            <Text bold color={PINK}>{status}</Text>
          ) : (
            <Text dimColor color={status === 'Next' ? undefined : GREY}>{status}</Text>
          )}
        </Text>
      )
    })
    const more = byCalls ? 0 : total - rows.length

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} width="100%">
        {header}
        {progress}
        {byCalls && first > 0 ? <Text dimColor>{`+${first} earlier`}</Text> : null}
        {rows}
        {more > 0 ? <Text dimColor>{`+${more} more`}</Text> : null}
      </Box>
    )
  })
}
