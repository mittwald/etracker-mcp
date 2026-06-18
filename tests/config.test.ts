import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_API_URL, loadConfig } from '../src/config.js';

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

describe('loadConfig', () => {
  it('uses defaults when no env is set', () => {
    delete process.env.MCP_PORT;
    delete process.env.ETRACKER_API_URL;
    const config = loadConfig();
    expect(config.port).toBe(3334);
    expect(config.apiUrl).toBe(DEFAULT_API_URL);
  });

  it('reads MCP_PORT and trims trailing slashes from ETRACKER_API_URL', () => {
    process.env.MCP_PORT = '4000';
    process.env.ETRACKER_API_URL = 'https://ws.example.com/api/v7///';
    const config = loadConfig();
    expect(config.port).toBe(4000);
    expect(config.apiUrl).toBe('https://ws.example.com/api/v7');
  });
});
