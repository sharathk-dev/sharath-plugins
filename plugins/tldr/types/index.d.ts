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

export type Progress = {
  /** Duration of the turn that produced the answer. */
  tookMs: number
  /** Task-list length, or the main-loop tool-call count when there was no task list. */
  steps: number
}

export type Entry = {
  /** Full text of an answer that was summarized. */
  answer: string
  /** Non-empty line count of that answer. */
  lines: number
  summary: Summary
  /** Turn stats for the "All done" line of the inline card; null when unknown. */
  progress: Progress | null
}

export type Step = {
  /** Task id from TaskCreate's result; null for TodoWrite items. */
  id: string | null
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

declare module 'claude-code' {
  interface PluginState {
    tldr: {
      /** The last 20 summarized answers, each with the summary drawn under its last transcript block. */
      records: Entry[]
      /** Text of the answer whose summary is being generated, or '' (dim "summarizing…" line). */
      pending: string
      /** Text of the last long main-loop answer, for /tldr. */
      lastAnswer: string
      /** Bumped by every new turn, prompt or summary run; stale results are dropped. */
      epoch: number
      /** 'tldr' folds summarized answers in the transcript, leaving the TL;DR card; 'full' draws them as is. Persisted in the store. */
      view: 'full' | 'tldr'
      /** Turn state; the tldr-mode progress band is drawn only while working. */
      phase: 'idle' | 'working' | 'done' | 'stopped' | 'error'
      /** The turn's prompt, shown as the progress band's title. */
      prompt: string
      /** Claude's task list this turn, from TodoWrite, TaskCreate and TaskUpdate. */
      steps: Step[]
      /** Main-loop tool calls this turn, bookkeeping task tools excluded. */
      stepCount: number
      /** Label of the latest main-loop tool call, e.g. "Running: mvn test". */
      activity: string
      /** Animation frame and elapsed time, updated by the clock timer only while working. */
      pulse: { tick: number; elapsedMs: number }
    }
  }
}
