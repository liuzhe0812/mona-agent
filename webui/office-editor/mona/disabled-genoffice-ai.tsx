export const AI_REVISION_AUTHOR = 'Mona'
export const COMPLETED_VIA_TOOLS_TEXT = ''

export class AgentLoop {
  busy = false
  restore(): void {}
  run(): void {}
  cancel(): void {}
  reset(): void {}
}

export function composeSkills(): Record<string, never> {
  return {}
}

export function createIpcTransport(): Record<string, never> {
  return {}
}

export function AiPanel(): null {
  return null
}

export function AiChatPanel(): null {
  return null
}
