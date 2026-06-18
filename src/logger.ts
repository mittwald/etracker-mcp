type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
const threshold = LEVELS[configured] ?? LEVELS.info;

function emit(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < threshold) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
