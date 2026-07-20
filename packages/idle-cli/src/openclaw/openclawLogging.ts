export function summarizeOpenClawPromptForLog(prompt: string): string {
  return `Incoming prompt received (${prompt.length} characters)`;
}

export function summarizeOpenClawBackendMessageForLog<T extends { type: string }>(message: T): string {
  return `Backend message received (${message.type})`;
}
