/** off: the plugin stays out of the way; full: answer plus card; tldr: card only, answer folded. */
export type Mode = 'off' | 'full' | 'tldr'

export type Layout = 'answer' | 'table' | 'steps' | 'work'

export type Summary = {
  layout: Layout
  /** Output lines in order, except table rows and "● " lines. */
  body: string[]
  /** Markdown table cells, header row first; null when there is no table. */
  table: string[][] | null
  /** "● " lines: questions or actions for the user. */
  needs: string[]
  /** Non-empty line count of the original answer. */
  lines: number
}

export type Progress = {
  /** Duration of the turn that produced the answer. */
  tookMs: number
  /** Names of the steps taken this turn: the task list, or the main-loop tool calls when there was none. Consecutive repeats are collapsed to `name ×N`. */
  steps: string[]
}

export type Entry = {
  /** Full text of an answer that was summarized. */
  answer: string
  /** Non-empty line count of that answer. */
  lines: number
  summary: Summary
  /** Turn stats for the time and steps of the inline card; null when unknown. */
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
      /** The prompt that produced lastAnswer, for /tldr. */
      lastRequest: string
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
      /** Main-loop tool calls this turn as steps, shown when there is no task list. */
      calls: Step[]
      /** Label of the latest main-loop tool call, e.g. "Running: mvn test". */
      activity: string
      /** Animation frame and elapsed time, updated by the clock timer only while working. */
      pulse: { tick: number; elapsedMs: number }
    }
  }
}
