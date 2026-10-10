export type Summary = {
  /** One-line outcome. */
  done: string
  /** What was tested or run and its outcome; empty when nothing was verifiable. */
  verified: string
  /** Questions, decisions or actions the user must take (0-3). */
  needs: string[]
  /** Other key facts (0-2). */
  notes: string[]
  /** Non-empty line count of the original answer. */
  lines: number
}

declare module 'claude-code' {
  interface PluginState {
    tldr: {
      /** The summary shown in the band, or null when the band is hidden. */
      summary: Summary | null
      /** True while the model call runs (dim "summarizing…" line). */
      isPending: boolean
      /** Text of the last long main-loop answer, for /tldr. */
      lastAnswer: string
      /** Bumped by every new turn, prompt or summary run; stale results are dropped. */
      epoch: number
    }
  }
}
