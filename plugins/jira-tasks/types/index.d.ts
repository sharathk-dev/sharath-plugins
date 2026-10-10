export type PullRequest = { repo: string; number: number; url: string; isDraft: boolean }

export type Task = { key: string; summary: string; status: string; type: string; priority?: string; url?: string; category: 'To Do' | 'In Progress' | 'Done' | ''; parent?: string; isSubtask: boolean; prs?: PullRequest[] }

declare module 'claude-code' {
  interface PluginState {
    'jira-tasks': { cloudId: string; site: string }
  }
}
