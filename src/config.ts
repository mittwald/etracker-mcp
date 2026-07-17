export type EtrackerCredentials = {
  token: string;
};

export type AppConfig = {
  port: number;
  apiUrl: string;
  requestTimeoutMs: number;
};

export const HOST = '0.0.0.0';

/** Public etracker Report API base URL. */
export const DEFAULT_API_URL = 'https://ws.etracker.com/api/v7';

/** Long ranges (a year of daily rows) regularly need more than a minute. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export function loadConfig(): AppConfig {
  const timeout = Number(process.env.ETRACKER_REQUEST_TIMEOUT_MS);
  return {
    port: Number(process.env.MCP_PORT ?? 3334),
    apiUrl: (process.env.ETRACKER_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, ''),
    requestTimeoutMs:
      Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_REQUEST_TIMEOUT_MS,
  };
}
