import { atom, read, update } from 'claude-code'
import type { FsEntry, Register } from 'claude-code'

import type { RunRecord } from '../types'
import { compactText, detectTestRun, failureLocation, formatDuration, parseTestOutput } from './parse'

const runs = atom({ plugin: 'test-watcher', key: 'runs' } as const, {} as Record<string, RunRecord>)

/** Output shorter than this many lines is left to the model as it is. */
const MIN_LINES = 40
const MAX_RUNS = 50
const KEEP_LOGS = 50
const MAX_CARD_FAILURES = 8
const CARD_WIDTH = 100

const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text)

// What the run printed, as one text. A passing run answers { stdout, stderr }; a run that exited non-zero (a red
// build) is an errored call whose result is the error text ("Exit code 1" first).
function rawOutput(r: any): string | null {
  if (r?.deny !== undefined) return null
  if (r?.isError === true) {
    const t = typeof r.result === 'string' ? r.result : r.text
    return typeof t === 'string' ? t : null
  }
  const res = r?.result
  if (res && typeof res === 'object' && typeof res.stdout === 'string') {
    return typeof res.stderr === 'string' && res.stderr !== '' ? `${res.stdout}\n${res.stderr}` : res.stdout
  }
  return null
}

async function logPathFor($: any, id: string): Promise<string> {
  const xdg = await $.env.get('XDG_CACHE_HOME')
  const home = await $.env.get('HOME')
  const tmp = await $.env.get('TMPDIR')
  const base = xdg ? xdg : home ? `${home}/.cache` : tmp ? tmp : '/tmp'
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  return `${base.replace(/\/$/, '')}/test-watcher/${stamp}-${id.replace(/[^A-Za-z0-9_-]/g, '_')}.log`
}

// The delete is rm on exact paths of *.log files listed in the test-watcher log directory; $.fs has no delete.
async function pruneLogs($: any, logPath: string): Promise<void> {
  try {
    const dir = logPath.slice(0, logPath.lastIndexOf('/'))
    const logs = ((await $.fs.list(dir)) as FsEntry[])
      .filter(f => f.kind === 'file' && f.name.endsWith('.log'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1))
    const stale = logs.slice(KEEP_LOGS).map(f => `${dir}/${f.name}`)
    if (stale.length > 0) await $.process.run(['rm', '-f', '--', ...stale])
  } catch {
    // Pruning is housekeeping; a failure must not cost the caller its result.
  }
}

async function remember($: any, id: string, record: RunRecord): Promise<void> {
  await update($, runs, m => {
    const next = { ...m, [id]: record }
    const keys = Object.keys(next)
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_RUNS))) delete next[k]
    return next
  })
}

const tildeHome = async ($: any, path: string): Promise<string> => {
  const home = (await $.env.get('HOME')) as string | undefined
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

async function drawRow($: any, e: any, s: RunRecord) {
  const { Box, Text } = $.ui.resolve(e)
  const columns = e.viewport?.columns ?? 100
  const inner = Math.max(10, columns - 4)
  const dur = formatDuration(s.durationSec)
  const tail = dur ? ` · ${dur}` : ''
  const bad = s.failed + s.errors

  let status: string
  let color: 'green' | 'red'
  if (s.status === 'error') {
    status = '✗ build error'
    color = 'red'
  } else if (s.status === 'fail') {
    status = `✗ ${bad} failed · ${s.passed} passed${s.skipped ? ` · ${s.skipped} skipped` : ''}${tail}`
    color = 'red'
  } else {
    status = s.total === 0 ? `✓ build passed${tail}` : `✓ ${s.passed} passed${tail}`
    color = 'green'
  }

  const shown = s.failures.slice(0, MAX_CARD_FAILURES)
  const more = s.failures.length - shown.length
  const errorLines = s.status === 'error' ? (s.buildError ?? '').split('\n').filter(Boolean).slice(0, 4) : []
  const command = clip(String(e.props.input?.command ?? s.label), Math.max(10, columns - 10))
  const log = s.logPath ? await tildeHome($, s.logPath) : null

  const lines: any[] = [
    <Text key="status" bold color={color}>
      {clip(status, inner)}
    </Text>,
    ...errorLines.map((l, i) => <Text key={`be-${i}`}>{clip(l, inner)}</Text>),
    ...shown.map((f, i) => {
      const name = `✗ ${f.test}`
      const loc = failureLocation(f)
      const used = name.length + (loc ? loc.length + 2 : 0) + 2
      const msg = clip(f.message, Math.max(0, inner - used))
      return (
        <Box key={`f-${i}`}>
          <Text bold color="red">
            {name}
          </Text>
          {loc ? <Text dimColor>{`  ${loc}`}</Text> : null}
          {msg ? <Text>{`  ${msg}`}</Text> : null}
        </Box>
      )
    }),
    ...(more > 0 ? [<Text key="more" dimColor>{`+${more} more`}</Text>] : []),
    ...(log ? [<Text key="log" dimColor>{clip(`full log: ${log}`, inner)}</Text>] : []),
  ]

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>●</Text>
        <Text>{` Bash(${command})`}</Text>
      </Box>
      {lines.map((line, i) => (
        <Box key={`l-${i}`}>
          <Text dimColor>{i === 0 ? '  ⎿ ' : '    '}</Text>
          {line}
        </Box>
      ))}
    </Box>
  )
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const run = detectTestRun(String(e.command ?? ''))
    const r = await next(e)
    if (!run) return r
    try {
      const output = rawOutput(r)
      if (output === null) return r
      const summary = parseTestOutput(output, run.tool)
      if (!summary) return r

      const isLong = output.split('\n').length >= MIN_LINES
      if (!isLong) {
        await remember($, e.tool_use_id, { ...summary, label: run.label })
        return r
      }

      const path = await logPathFor($, e.tool_use_id)
      await $.fs.write(path, output)
      await pruneLogs($, path)
      await remember($, e.tool_use_id, { ...summary, label: run.label, logPath: path })

      const compact = compactText(summary, run.label, path)
      if ((r as any).isError === true) {
        // A Bash result must be { stdout, stderr }; an errored call is answered with deny, which the model reads as the error.
        const exit = /^Exit code \d+[^\n]*/.exec(output)?.[0]
        return { deny: exit ? `${exit}\n${compact}` : compact }
      }
      const { ref: _ref, text: _text, ...rest } = r as any
      return { ...rest, result: { ...rest.result, stdout: compact, stderr: '' } } as typeof r
    } catch {
      return r
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    try {
      if (e.props.tool !== 'Bash') return next(e)
      const all = await read($, runs)
      if (!all[e.props.tool_use_id ?? e.requestId]) return next(e)
      const { Box } = $.ui.resolve(e)
      return <Box />
    } catch {
      return next(e)
    }
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    try {
      if (e.props.tool !== 'Bash' || e.props.isRunning) return next(e)
      const all = await read($, runs)
      const s = all[e.props.tool_use_id ?? e.requestId]
      if (!s) return next(e)
      return drawRow($, e, s)
    } catch {
      return next(e)
    }
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    try {
      if (e.props.isExpanded) return next(e)
      const all = await read($, runs)
      const isRecorded = e.props.calls.some(c => c.tool_use_id !== undefined && !c.isRunning && all[c.tool_use_id] !== undefined)
      return isRecorded ? next({ ...e, props: { ...e.props, isExpanded: true } }) : next(e)
    } catch {
      return next(e)
    }
  })
}
