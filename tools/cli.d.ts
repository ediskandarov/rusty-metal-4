export class UsageError extends Error {}
export function runCli(action: () => Promise<void>): Promise<void>;
