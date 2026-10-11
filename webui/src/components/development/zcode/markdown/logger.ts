type LogContext = Record<string, unknown>;

export const logger = {
  debug: (_message: string, _context?: LogContext) => undefined,
  info: (_message: string, _context?: LogContext) => undefined,
  warn: (message: string, context?: LogContext) => console.warn(message, context),
};
