export type RunRecord = {
  tool: 'maven' | 'gradle'
  /** The command as shown in the card header, e.g. `mvn test`. */
  label: string
  status: 'pass' | 'fail' | 'error'
  total: number
  passed: number
  failed: number
  errors: number
  skipped: number
  durationSec?: number
  failures: Array<{ test: string; file?: string; line?: number; message: string }>
  buildError?: string
  /** Where the full log was saved; absent when the output was short and left untouched. */
  logPath?: string
}

declare module 'claude-code' {
  interface PluginState {
    'test-watcher': {
      /** Parsed test runs by Bash tool_use_id, for the result card. Newest 50 kept. */
      runs: Record<string, RunRecord>
    }
  }
}
