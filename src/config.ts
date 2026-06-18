export type EtrackerCredentials = {
  token: string;
};

export type AppConfig = {
  port: number;
  apiUrl: string;
};

export const HOST = '0.0.0.0';

/** Public etracker Report API base URL. */
export const DEFAULT_API_URL = 'https://ws.etracker.com/api/v7';

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.MCP_PORT ?? 3334),
    apiUrl: (process.env.ETRACKER_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, ''),
  };
}
