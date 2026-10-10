// Pure helpers for test-watcher: command detection, Maven/Gradle output parsing, compact text.
// No `$` in here, so the tests import this file directly.

export type Failure = {
  /** `CalculatorTest.add` */
  test: string
  /** `CalculatorTest.java` */
  file?: string
  line?: number
  message: string
}

export type TestSummary = {
  tool: 'maven' | 'gradle'
  /** pass: build green; fail: tests failed; error: the build itself broke (compile error, resolution...). */
  status: 'pass' | 'fail' | 'error'
  total: number
  passed: number
  failed: number
  errors: number
  skipped: number
  durationSec?: number
  failures: Failure[]
  buildError?: string
}

export type TestRun = { tool: 'maven' | 'gradle'; label: string }

// ---------------------------------------------------------------------------------------------
// Command detection
// ---------------------------------------------------------------------------------------------

/** Splits a shell line into simple commands (on && || ; | & newline and parentheses, outside quotes), each as tokens. */
export function splitCommands(line: string): string[][] {
  const out: string[][] = []
  let tokens: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  const endToken = () => {
    if (has) tokens.push(cur)
    cur = ''
    has = false
  }
  const endCommand = () => {
    endToken()
    if (tokens.length) out.push(tokens)
    tokens = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i]
      has = true
    } else if (c === '&' && (line[i - 1] === '>' || line[i + 1] === '>')) {
      // `2>&1` and `&>file` are redirections, not separators.
      cur += c
      has = true
    } else if (c === '&' || c === '|' || c === ';' || c === '\n' || c === '(' || c === ')') {
      endCommand()
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endToken()
    } else {
      cur += c
      has = true
    }
  }
  endCommand()
  return out
}

const WRAPPERS = new Set(['env', 'time', 'sudo', 'nohup', 'exec', 'command', 'nice', 'xvfb-run'])
const MAVEN_BINS = new Set(['mvn', 'mvnw', 'mvnw.cmd', 'mvnd'])
const GRADLE_BINS = new Set(['gradle', 'gradlew', 'gradlew.bat'])
const MAVEN_GOALS = new Set(['test', 'verify', 'install', 'package'])
const GRADLE_TASKS = new Set(['test', 'check', 'build'])

function stripWrappers(tokens: string[]): string[] {
  let i = 0
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || WRAPPERS.has(tokens[i]!))) i++
  return tokens.slice(i)
}

function mavenRun(args: string[]): TestRun | null {
  if (args.some(a => /^-D(skipTests|maven\.test\.skip)(=true)?$/.test(a))) return null
  const goal = args.find(a => !a.startsWith('-') && (MAVEN_GOALS.has(a) || a.endsWith(':test')))
  if (goal) return { tool: 'maven', label: `mvn ${goal}` }
  if (args.some(a => a.startsWith('-Dtest='))) return { tool: 'maven', label: 'mvn test' }
  return null
}

function gradleRun(args: string[]): TestRun | null {
  const kept: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-x' || a === '--exclude-task') i++ // `-x test` excludes a task; its name is no request
    else kept.push(a)
  }
  if (kept.includes('--tests') || kept.some(a => a.startsWith('--tests='))) return { tool: 'gradle', label: 'gradle test' }
  const task = kept.find(a => !a.startsWith('-') && GRADLE_TASKS.has(a.slice(a.lastIndexOf(':') + 1)))
  return task ? { tool: 'gradle', label: `gradle ${task.slice(task.lastIndexOf(':') + 1)}` } : null
}

/** Whether a Bash command runs Maven or Gradle tests anywhere in a chain; null when it does not. */
export function detectTestRun(command: string): TestRun | null {
  try {
    for (const simple of splitCommands(command)) {
      const tokens = stripWrappers(simple)
      if (!tokens.length) continue
      const bin = tokens[0]!.slice(tokens[0]!.lastIndexOf('/') + 1)
      const run = MAVEN_BINS.has(bin) ? mavenRun(tokens.slice(1)) : GRADLE_BINS.has(bin) ? gradleRun(tokens.slice(1)) : null
      if (run) return run
    }
  } catch {
    // fall through
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/** `dev.x.CalculatorTest.add` -> `CalculatorTest.add`. */
function shortTest(fq: string): string {
  const parts = fq.split('.')
  return parts.slice(-2).join('.')
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** `org.x.AssertionFailedError: expected: <5> but was: <1>` -> `expected: <5> but was: <1>`. */
function exceptionMessage(line: string): string {
  const t = line.trim()
  const m = /^[\w.$]+(?:Error|Exception|Failure|Throwable)?(?::\s*(.*))?$/.exec(t)
  if (!m) return t
  if (m[1] !== undefined && m[1] !== '') return m[1]
  const name = t.replace(/:\s*$/, '')
  return name.slice(name.lastIndexOf('.') + 1)
}

function finish(s: Omit<TestSummary, 'passed'> & { passed?: number }): TestSummary {
  const passed = s.passed ?? Math.max(0, s.total - s.failed - s.errors - s.skipped)
  return { ...s, passed }
}

function mavenDuration(text: string): number | undefined {
  const m = /Total time:\s+(.+?)\s*$/m.exec(text)
  if (!m) return undefined
  const v = m[1]!
  let r: RegExpExecArray | null
  if ((r = /^([\d.]+) s/.exec(v))) return Number(r[1])
  if ((r = /^(\d+):(\d+) min/.exec(v))) return Number(r[1]) * 60 + Number(r[2])
  if ((r = /^(\d+):(\d+) h/.exec(v))) return Number(r[1]) * 3600 + Number(r[2]) * 60
  return undefined
}

function buildErrorText(errors: string[]): string {
  const first = errors.slice(0, 3)
  if (errors.length > 3) first.push(`+${errors.length - 3} more`)
  return first.join('\n')
}

function parseMaven(raw: string[]): TestSummary | null {
  // Drop the `[INFO] `/`[ERROR] `/`[WARNING] ` prefix; keep the indentation after it.
  const lines = raw.map(l => l.replace(/^\[(?:INFO|ERROR|WARNING|WARN|DEBUG)\] ?/, ''))
  const text = lines.join('\n')

  // Totals: the aggregate "Tests run:" lines carry no "Time elapsed" (one per module); per-class lines are the fallback.
  const sum = { total: 0, failed: 0, errors: 0, skipped: 0 }
  let aggregates = 0
  const perClass = { total: 0, failed: 0, errors: 0, skipped: 0 }
  let classes = 0
  for (const l of lines) {
    const m = /Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)(.*)$/.exec(l)
    if (!m) continue
    const into = /Time elapsed/.test(m[5]!) ? perClass : sum
    if (into === sum) aggregates++
    else classes++
    into.total += Number(m[1])
    into.failed += Number(m[2])
    into.errors += Number(m[3])
    into.skipped += Number(m[4])
  }
  const totals = aggregates > 0 ? sum : perClass
  const hasTotals = aggregates + classes > 0

  const buildOk = /^BUILD SUCCESS\s*$/m.test(text)
  const buildFailed = /^BUILD FAILURE\s*$/m.test(text)
  if (!hasTotals && !buildOk && !buildFailed) return null

  // Compile errors: `/path/Foo.java:[12,5] cannot find symbol` (+ `  symbol:   variable x`), each printed twice by Maven.
  const compile: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\S.*?\.(?:java|kt|scala|groovy)):\[(\d+),(\d+)\]\s*(.*)$/.exec(lines[i]!)
    if (!m) continue
    let detail = ''
    const next = /^\s+symbol:\s+(.*)$/.exec(lines[i + 1] ?? '')
    if (next) detail = ` (${next[1]!.trim()})`
    const msg = `${baseName(m[1]!)}:${m[2]}: ${m[4]}${detail}`
    if (seen.has(msg)) continue
    seen.add(msg)
    compile.push(msg)
  }

  const durationSec = mavenDuration(text)
  const hadTestFailures = totals.failed + totals.errors > 0

  if (compile.length && !hadTestFailures) {
    return finish({ tool: 'maven', status: 'error', ...totals, durationSec, failures: [], buildError: buildErrorText(compile) })
  }

  const failures = hadTestFailures || buildFailed ? mavenFailures(lines) : []

  if (hadTestFailures || failures.length) {
    return finish({ tool: 'maven', status: 'fail', ...totals, durationSec, failures })
  }
  if (buildFailed) {
    const goal = lines.find(l => /^Failed to execute goal /.test(l)) ?? lines.find(l => /^(?:Failed to|Could not|Non-resolvable|Unknown lifecycle)/.test(l))
    return finish({ tool: 'maven', status: 'error', ...totals, durationSec, failures: [], buildError: clip(goal?.trim() ?? 'BUILD FAILURE', 400) })
  }
  return finish({ tool: 'maven', status: 'pass', ...totals, durationSec, failures: [] })
}

function mavenFailures(lines: string[]): Failure[] {
  const byTest = new Map<string, Failure>()
  const order: string[] = []
  const put = (f: Failure) => {
    const old = byTest.get(f.test)
    if (!old) {
      byTest.set(f.test, f)
      order.push(f.test)
    } else {
      byTest.set(f.test, { ...old, file: old.file ?? f.file, line: old.line ?? f.line, message: old.message || f.message })
    }
  }

  // Detail blocks: `pkg.Class.method -- Time elapsed: 0.003 s <<< FAILURE!`, then the exception and its frames.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    let fq: string | undefined
    let m = /^(\S+?) -- Time elapsed: [\d.,]+ s <<< (?:FAILURE|ERROR)!/.exec(l)
    if (m) fq = m[1]
    else if ((m = /^(\S+?)\(([\w.$]+)\)\s+Time elapsed: [\d.,]+ s\s+<<< (?:FAILURE|ERROR)!/.exec(l))) fq = `${m[2]}.${m[1]}`
    if (!fq) continue
    const cls = fq.slice(0, fq.lastIndexOf('.'))
    const method = fq.slice(fq.lastIndexOf('.') + 1)
    const exc = lines[i + 1] ?? ''
    const message = exc && !/^\s+at /.test(exc) ? exceptionMessage(exc) : ''
    let file: string | undefined
    let line: number | undefined
    for (let j = i + 1; j < lines.length && j < i + 80; j++) {
      const f = /^\s+at ([\w.$]+)\.([\w$<>]+)\(([\w$]+\.\w+):(\d+)\)/.exec(lines[j]!)
      if (f && f[1] === cls) {
        file = f[3]
        line = Number(f[4])
        break
      }
      if (lines[j] === '') break
    }
    put({ test: shortTest(`${cls}.${method}`), file, line, message })
  }

  // Summary sections: `Failures:` / `Errors:` then `  Class.method:14 message`.
  let inSection = false
  for (const l of lines) {
    if (/^(?:Failures|Errors|Flaked tests): ?$/.test(l)) {
      inSection = true
      continue
    }
    if (!inSection) continue
    const m = /^ {2,}([\w.$\[\]()-]+?)(?::(\d+))?(?:\s+(?:» )?(.*))?$/.exec(l)
    if (!m) {
      inSection = false
      continue
    }
    const test = shortTest(m[1]!)
    const cls = test.split('.')[0]!.split('$')[0]!
    put({ test, file: `${cls}.java`, line: m[2] ? Number(m[2]) : undefined, message: (m[3] ?? '').trim() })
  }

  // The summary's `Class.java` guess must not win over a real frame; `put` keeps the first, and blocks come first.
  return order.map(k => byTest.get(k)!)
}

function gradleDuration(text: string): number | undefined {
  const m = /^BUILD (?:SUCCESSFUL|FAILED) in (.+?)\s*$/m.exec(text)
  if (!m) return undefined
  let sec = 0
  let found = false
  for (const part of m[1]!.matchAll(/(\d+)\s*(ms|h|m|s)\b/g)) {
    found = true
    const n = Number(part[1])
    sec += part[2] === 'h' ? n * 3600 : part[2] === 'm' ? n * 60 : part[2] === 's' ? n : n / 1000
  }
  return found ? sec : undefined
}

function parseGradle(lines: string[]): TestSummary | null {
  const text = lines.join('\n')
  const buildOk = /^BUILD SUCCESSFUL/m.test(text)
  const buildFailed = /^BUILD FAILED/m.test(text)
  const completed = /(\d+) tests? completed(?:, (\d+) failed)?(?:, (\d+) skipped)?/.exec(text)
  const events = { passed: 0, failed: 0, skipped: 0 }
  for (const l of lines) {
    if (/^\S.* > .+ PASSED\s*$/.test(l)) events.passed++
    else if (/^\S.* > .+ FAILED\s*$/.test(l)) events.failed++
    else if (/^\S.* > .+ SKIPPED\s*$/.test(l)) events.skipped++
  }
  if (!buildOk && !buildFailed && !completed && events.failed === 0) return null

  // Failures: `CalculatorTest > add() FAILED`, an indented exception line, indented frames.
  const failures: Failure[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\S.*?) > (.+) FAILED\s*$/.exec(lines[i]!)
    if (!m || m[1]!.startsWith('>')) continue
    const fqClass = m[1]!.trim()
    const cls = fqClass.slice(fqClass.lastIndexOf('.') + 1)
    const method = m[2]!.replace(/\(.*$/, '').trim() || m[2]!
    let message = ''
    let file: string | undefined
    let line: number | undefined
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!
      if (l.trim() === '' || !/^\s/.test(l)) break
      if (/^\s+at /.test(l)) {
        const f = /at (?:[\w.-]+\/\/)?([\w.$]+)\.([\w$<>]+)\(([\w$]+\.\w+):(\d+)\)/.exec(l)
        if (f && !file && (f[1] === fqClass || f[1]!.endsWith(`.${cls}`) || f[1] === cls)) {
          file = f[3]
          line = Number(f[4])
        }
      } else if (!message) {
        message = exceptionMessage(l)
      }
    }
    failures.push({ test: `${cls}.${method}`, file, line, message })
  }

  let total: number
  let failed: number
  let skipped: number
  if (completed) {
    total = Number(completed[1])
    failed = Number(completed[2] ?? 0)
    skipped = Number(completed[3] ?? 0)
  } else {
    failed = Math.max(events.failed, failures.length)
    skipped = events.skipped
    total = events.passed + failed + skipped
  }
  const durationSec = gradleDuration(text)

  if (failed > 0 || failures.length > 0) {
    return finish({ tool: 'gradle', status: 'fail', total, failed: Math.max(failed, failures.length), errors: 0, skipped, durationSec, failures })
  }

  if (buildFailed) {
    const compile: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\S.*?\.(?:java|groovy|scala)):(\d+): error: (.*)$/.exec(lines[i]!) ?? /^e: (?:file:\/\/)?(\S+?\.kt):\(?(\d+)(?::\d+)?\)?:? (.*)$/.exec(lines[i]!)
      if (!m) continue
      // javac prints the source line and a caret before `symbol:`; stop at the next error.
      let sym: RegExpExecArray | null = null
      for (let j = i + 1; j <= i + 4 && j < lines.length && !sym; j++) {
        if (/: error: /.test(lines[j]!)) break
        sym = /^\s+symbol:\s+(.*)$/.exec(lines[j]!)
      }
      compile.push(`${baseName(m[1]!)}:${m[2]}: ${m[3]}${sym ? ` (${sym[1]!.trim()})` : ''}`)
    }
    if (compile.length) return finish({ tool: 'gradle', status: 'error', total, failed: 0, errors: 0, skipped, durationSec, failures: [], buildError: buildErrorText(compile) })
    const w = lines.findIndex(l => /^\* What went wrong:/.test(l))
    const reason = w >= 0 ? lines.slice(w + 1).find(l => l.trim() !== '') : undefined
    return finish({ tool: 'gradle', status: 'error', total, failed: 0, errors: 0, skipped, durationSec, failures: [], buildError: clip(reason?.trim() ?? 'BUILD FAILED', 400) })
  }
  return finish({ tool: 'gradle', status: 'pass', total, failed: 0, errors: 0, skipped, durationSec, failures: [] })
}

/** Parses the combined stdout+stderr of a Maven or Gradle run. Null when it cannot make sense of it. */
export function parseTestOutput(output: string, hint?: 'maven' | 'gradle'): TestSummary | null {
  try {
    const lines = output.replace(ANSI, '').replace(/\r/g, '').split('\n')
    const looksGradle = lines.some(l => /^> Task :|^BUILD (?:SUCCESSFUL|FAILED)|^\d+ tests? completed/.test(l))
    const looksMaven = lines.some(l => /^\[(?:INFO|ERROR|WARNING)\] (?:BUILD (?:SUCCESS|FAILURE)|Tests run:)/.test(l))
    const order: Array<'maven' | 'gradle'> = looksMaven && !looksGradle ? ['maven'] : looksGradle && !looksMaven ? ['gradle'] : hint ? [hint] : ['maven', 'gradle']
    for (const tool of order) {
      const r = tool === 'maven' ? parseMaven(lines) : parseGradle(lines)
      if (r) return r
    }
  } catch {
    // unparseable
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------

export function formatDuration(sec: number | undefined): string {
  if (sec === undefined) return ''
  if (sec >= 60) {
    const m = Math.floor(sec / 60)
    return `${m}m${String(Math.round(sec - m * 60)).padStart(2, '0')}s`
  }
  return `${sec.toFixed(1)}s`
}

export function failureLocation(f: Failure): string {
  return f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : ''
}

/** What the model reads in place of the full log. */
export function compactText(s: TestSummary, label: string, logPath: string, maxFailures = 20): string {
  const dur = formatDuration(s.durationSec)
  const tail = dur ? ` · ${dur}` : ''
  const lines: string[] = []
  const bad = s.failed + s.errors
  if (s.status === 'error') {
    lines.push(`${label}: BUILD ERROR${tail}`)
    for (const l of (s.buildError ?? '').split('\n')) lines.push(`✗ ${l}`)
  } else if (s.status === 'fail') {
    lines.push(`${label}: FAILED · ${bad} failed, ${s.passed} passed, ${s.skipped} skipped${tail}`)
    for (const f of s.failures.slice(0, maxFailures)) {
      const loc = failureLocation(f)
      lines.push(`✗ ${f.test}${loc ? ` (${loc})` : ''}${f.message ? `: ${clip(f.message, 300)}` : ''}`)
    }
    if (s.failures.length > maxFailures) lines.push(`+${s.failures.length - maxFailures} more failures (see the full log)`)
  } else if (s.total === 0) {
    lines.push(`${label}: PASSED · no tests ran${tail}`)
  } else {
    lines.push(`${label}: PASSED · ${s.passed} passed, ${s.skipped} skipped${tail}`)
  }
  lines.push(`Full log: ${logPath}  (read it if you need more detail)`)
  return lines.join('\n')
}
