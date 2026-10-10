import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { Summary } from '../types'

const summary = atom({ plugin: 'tldr', key: 'summary' } as const, null)
const isPending = atom({ plugin: 'tldr', key: 'isPending' } as const, false)
const lastAnswer = atom({ plugin: 'tldr', key: 'lastAnswer' } as const, '')
const epoch = atom({ plugin: 'tldr', key: 'epoch' } as const, 0)

const MIN_LINES = 10
const MIN_CHARS = 800
const MAX_WIDTH = 110
const CARD_WIDTH = 100
const LIMITS = { done: 1, needs: 3, notes: 2 }

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

function clip(text: string, width: number): string {
  return text.length > width ? text.slice(0, Math.max(1, width - 1)) + '…' : text
}

function parseSummary(raw: string, lines: number): Summary | null {
  const out: Summary = { done: '', verified: '', needs: [], notes: [], lines }
  for (const line of raw.split('\n')) {
    const m = /^[\s>*\-•#]*\**\s*(DONE|VERIFIED|NEEDS YOU|NOTE)\s*\**\s*:\s*\**\s*(.+?)\s*$/i.exec(line)
    if (!m) continue
    const body = clip(m[2]!.replace(/\*\*|`/g, ''), MAX_WIDTH)
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
async function summarize($: any, answer: string): Promise<Summary | null> {
  await update($, epoch, n => n + 1)
  const myEpoch = await read($, epoch)
  await update($, isPending, () => true)
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
  await update($, summary, () => result)
  await update($, isPending, () => false)
  return result
}

async function clear($: any): Promise<void> {
  await update($, epoch, n => n + 1)
  await update($, summary, () => null)
  await update($, isPending, () => false)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tldr',
      description: 'Re-summarize the last long answer; "/tldr off" or "/tldr on" toggles the automatic band',
    })
    return next(e)
  })

  on('command.run', { command: 'tldr' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await $.store.set('auto', arg === 'on')
      return { text: `tldr auto mode ${arg}.` }
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

  on('turn.start', async ($, e, next) => {
    await update($, epoch, n => n + 1)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await clear($).catch(() => {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return result

    if (!isLong(e.answer)) {
      await update($, lastAnswer, () => '')
      await clear($)
      return result
    }

    await update($, lastAnswer, () => e.answer)
    if ((await $.store.get('auto')) !== false) {
      void summarize($, e.answer)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, summary)
    const pending = await read($, isPending)
    if (e.props.hasSurvey || (shown === null && !pending)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const cardWidth = Math.min(CARD_WIDTH, e.viewport?.columns ?? CARD_WIDTH)
    const width = Math.max(10, cardWidth - 4)

    if (shown === null) {
      return <Text dimColor>summarizing…</Text>
    }

    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={cardWidth}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>TL;DR</Text>
          <Box>
            <Text dimColor>{`${shown.lines} lines → ${(shown.done ? 1 : 0) + (shown.verified ? 1 : 0) + shown.needs.length + shown.notes.length} `}</Text>
            <Button key="dismiss" label="✕" onPress={() => clear($)} />
          </Box>
        </Box>
        {shown.done ? <Text>{clip(`✓ ${shown.done}`, width)}</Text> : null}
        {shown.verified ? (
          <Text
            color={verifiedColor(shown.verified)}
            dimColor={/not run/i.test(shown.verified)}
          >
            {clip(`✔︎ verified: ${shown.verified}`, width)}
          </Text>
        ) : null}
        {shown.needs.map((line, i) => (
          <Text key={`needs-${i}`} bold color="yellow">
            {clip(`● ${line}`, width)}
          </Text>
        ))}
        {shown.notes.map((line, i) => (
          <Text key={`note-${i}`} dimColor>
            {clip(`· ${line}`, width)}
          </Text>
        ))}
      </Box>
    )
  })
}
