import { expect, test } from 'claude-code/testing'

import { compactText, detectTestRun, formatDuration, parseTestOutput } from '../hooks/parse'

import * as fx from './fixtures'

const FIXTURES: Record<string, string> = {
  'maven-pass.txt': fx.mavenPass,
  'maven-fail.txt': fx.mavenFail,
  'maven-compile-error.txt': fx.mavenCompileError,
  'gradle-fail.txt': fx.gradleFail,
  'gradle-pass.txt': fx.gradlePass,
  'gradle-compile-error.txt': fx.gradleCompileError,
}
const fixture = async (_$: unknown, name: string): Promise<string> => FIXTURES[name]!

test('maven green run', async $ => {
  const s = parseTestOutput(await fixture($, 'maven-pass.txt'), 'maven')!
  expect(s).toMatchObject({ tool: 'maven', status: 'pass', total: 4, passed: 3, failed: 0, errors: 0, skipped: 1, durationSec: 0.756, failures: [] })
})

test('maven failing assertion and error', async $ => {
  const s = parseTestOutput(await fixture($, 'maven-fail.txt'))!
  expect(s).toMatchObject({ tool: 'maven', status: 'fail', total: 5, passed: 2, failed: 1, errors: 1, skipped: 1, durationSec: 0.794 })
  expect(s.failures).toEqual([
    { test: 'CalculatorTest.addsTwoNumbers', file: 'CalculatorTest.java', line: 13, message: 'expected: <5> but was: <1>' },
    { test: 'BoomTest.explodes', file: 'BoomTest.java', line: 10, message: 'Cannot invoke "Object.toString()" because "o" is null' },
  ])
})

test('maven compile error gives status error and the first errors with file:line', async $ => {
  const s = parseTestOutput(await fixture($, 'maven-compile-error.txt'))!
  expect(s.status).toBe('error')
  expect(s.failures).toEqual([])
  expect(s.buildError).toBe('Calculator.java:10: cannot find symbol (variable bb)\nCalculator.java:10: cannot find symbol (method undefinedThing())')
})

test('maven compile errors are capped at three', () => {
  const errs = [1, 2, 3, 4, 5].map(i => `[ERROR] /p/A.java:[${i},1] bad ${i}`)
  const s = parseTestOutput(['[INFO] Compiling', '[ERROR] COMPILATION ERROR :', ...errs, '[INFO] BUILD FAILURE', '[INFO] Total time:  1.0 s'].join('\n'))!
  expect(s.buildError).toBe('A.java:1: bad 1\nA.java:2: bad 2\nA.java:3: bad 3\n+2 more')
})

test('maven multi-module sums the module totals; minutes parse', () => {
  const out = [
    '[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0',
    '[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 1',
    '[INFO] BUILD SUCCESS',
    '[INFO] Total time:  01:03 min',
  ].join('\n')
  expect(parseTestOutput(out)).toMatchObject({ status: 'pass', total: 7, passed: 6, skipped: 1, durationSec: 63 })
})

test('maven old-style surefire output and ANSI colours', () => {
  const out = [
    '\u001b[1;31m[ERROR]\u001b[m Tests run: 4, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.1 s <<< FAILURE! - in com.x.CalculatorTest',
    '[ERROR] add(com.x.CalculatorTest)  Time elapsed: 0.01 s  <<< FAILURE!',
    'java.lang.AssertionError: expected:<5> but was:<-1>',
    '\tat com.x.CalculatorTest.add(CalculatorTest.java:14)',
    '',
    '[ERROR] Failures: ',
    '[ERROR]   CalculatorTest.add:14 expected:<5> but was:<-1>',
    '[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0',
    '[INFO] BUILD FAILURE',
    '[INFO] Total time:  3.104 s',
  ].join('\n')
  const s = parseTestOutput(out)!
  expect(s).toMatchObject({ status: 'fail', total: 4, passed: 3, failed: 1, durationSec: 3.104 })
  expect(s.failures).toEqual([{ test: 'CalculatorTest.add', file: 'CalculatorTest.java', line: 14, message: 'expected:<5> but was:<-1>' }])
})

test('maven failure from the summary section alone (no detail blocks)', () => {
  const out = ['[ERROR] Failures: ', '[ERROR]   CalculatorTest.add:14 expected: <5> but was: <-1>', '[ERROR] Tests run: 4, Failures: 1, Errors: 0, Skipped: 0', '[INFO] BUILD FAILURE'].join('\n')
  expect(parseTestOutput(out)!.failures).toEqual([{ test: 'CalculatorTest.add', file: 'CalculatorTest.java', line: 14, message: 'expected: <5> but was: <-1>' }])
})

test('maven BUILD FAILURE with no tests and no compile error is a build error', () => {
  const out = ['[INFO] BUILD FAILURE', '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-clean-plugin:3.2.0:clean (default-clean) on project x: boom'].join('\n')
  const s = parseTestOutput(out)!
  expect(s.status).toBe('error')
  expect(s.buildError).toContain('Failed to execute goal')
})

test('gradle failing run', async $ => {
  const s = parseTestOutput(await fixture($, 'gradle-fail.txt'), 'gradle')!
  expect(s).toMatchObject({ tool: 'gradle', status: 'fail', total: 4, failed: 2, passed: 1, skipped: 1, durationSec: 2 })
  expect(s.failures).toEqual([
    { test: 'CalculatorTest.add', file: 'CalculatorTest.java', line: 14, message: 'expected: <5> but was: <-1>' },
    { test: 'BoomTest.explodes', file: 'BoomTest.java', line: 10, message: 'Cannot invoke "Object.toString()" because "o" is null' },
  ])
})

test('gradle green run has no counts but still parses', async $ => {
  const s = parseTestOutput(await fixture($, 'gradle-pass.txt'))!
  expect(s).toMatchObject({ tool: 'gradle', status: 'pass', total: 0, durationSec: 63 })
})

test('gradle green run with --info test events counts them', () => {
  const out = ['A > one() PASSED', 'A > two() PASSED', 'A > three() SKIPPED', '', 'BUILD SUCCESSFUL in 450ms'].join('\n')
  expect(parseTestOutput(out)).toMatchObject({ status: 'pass', total: 3, passed: 2, skipped: 1, durationSec: 0.45 })
})

test('gradle compile error', async $ => {
  const s = parseTestOutput(await fixture($, 'gradle-compile-error.txt'))!
  expect(s.status).toBe('error')
  expect(s.buildError).toBe('Calculator.java:10: cannot find symbol (variable bb)\nCalculator.java:14: incompatible types: String cannot be converted to int')
})

test('unparseable output gives null', () => {
  expect(parseTestOutput('')).toBeNull()
  expect(parseTestOutput('hello\nworld\nnothing to see')).toBeNull()
  expect(parseTestOutput('Exit code 127\nbash: mvn: command not found')).toBeNull()
})

test('compact text: failure', async $ => {
  const s = parseTestOutput(await fixture($, 'maven-fail.txt'))!
  expect(compactText(s, 'mvn test', '/x/y.log')).toBe(
    [
      'mvn test: FAILED · 2 failed, 2 passed, 1 skipped · 0.8s',
      '✗ CalculatorTest.addsTwoNumbers (CalculatorTest.java:13): expected: <5> but was: <1>',
      '✗ BoomTest.explodes (BoomTest.java:10): Cannot invoke "Object.toString()" because "o" is null',
      'Full log: /x/y.log  (read it if you need more detail)',
    ].join('\n'),
  )
})

test('compact text: pass is one line plus the log', async $ => {
  const s = parseTestOutput(await fixture($, 'maven-pass.txt'))!
  expect(compactText(s, 'mvn verify', '/x/y.log')).toBe('mvn verify: PASSED · 3 passed, 1 skipped · 0.8s\nFull log: /x/y.log  (read it if you need more detail)')
})

test('compact text: build error and failure cap', async $ => {
  const e = parseTestOutput(await fixture($, 'maven-compile-error.txt'))!
  const text = compactText(e, 'mvn test', '/l')
  expect(text.split('\n')[0]).toBe('mvn test: BUILD ERROR · 0.4s')
  expect(text).toContain('✗ Calculator.java:10: cannot find symbol (variable bb)')
  const many = { ...e, status: 'fail' as const, buildError: undefined, failed: 25, failures: Array.from({ length: 25 }, (_, i) => ({ test: `T.t${i}`, message: 'm' })) }
  const capped = compactText(many, 'mvn test', '/l')
  expect(capped).toContain('+5 more failures')
  expect(capped.split('\n').length).toBe(1 + 20 + 1 + 1)
})

test('durations', () => {
  expect(formatDuration(3.104)).toBe('3.1s')
  expect(formatDuration(63)).toBe('1m03s')
  expect(formatDuration(undefined)).toBe('')
})

test('detection: positive cases', () => {
  const yes = (cmd: string, tool: string, label: string) => expect(detectTestRun(cmd)).toEqual({ tool, label })
  yes('mvn test', 'maven', 'mvn test')
  yes('mvn -B clean verify', 'maven', 'mvn verify')
  yes('./mvnw install', 'maven', 'mvn install')
  yes('mvnw package -q', 'maven', 'mvn package')
  yes('mvn -Dtest=CalculatorTest', 'maven', 'mvn test')
  yes('cd app && mvn test', 'maven', 'mvn test')
  yes('echo hi; ./mvnw -pl core test 2>&1 | tail -50', 'maven', 'mvn test')
  yes('JAVA_HOME=/jdk mvn test', 'maven', 'mvn test')
  yes('time /opt/maven/bin/mvn test', 'maven', 'mvn test')
  yes('mvn -DskipTests package && mvn test', 'maven', 'mvn test')
  yes('gradle test', 'gradle', 'gradle test')
  yes('./gradlew check', 'gradle', 'gradle check')
  yes('gradlew build', 'gradle', 'gradle build')
  yes('./gradlew :app:test --tests "com.x.CalculatorTest"', 'gradle', 'gradle test')
  yes('./gradlew --tests CalculatorTest', 'gradle', 'gradle test')
  yes('cd x && (./gradlew clean build)', 'gradle', 'gradle build')
})

test('detection: negative cases', () => {
  for (const cmd of [
    '',
    'ls -la',
    'grep mvn pom.xml',
    'grep -r "mvn test" docs',
    'echo "mvn test"',
    'cat build.gradle',
    'git commit -m "gradle test"',
    'mvn -DskipTests package',
    'mvn package -DskipTests=true',
    'mvn install -Dmaven.test.skip=true',
    'mvn clean',
    'mvn dependency:tree',
    './mvnw compile',
    './gradlew tasks',
    'npm test',
    'pytest',
  ]) {
    expect(detectTestRun(cmd)).toBeNull()
  }
})
