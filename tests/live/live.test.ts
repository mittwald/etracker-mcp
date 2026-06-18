import { describe, expect, it } from 'vitest';
import { DEFAULT_API_URL } from '../../src/config.js';
import { EtrackerClient } from '../../src/etracker-client.js';

// Live smoke test against a real etracker account. Skipped unless ETRACKER_TOKEN
// is set. Run with: ETRACKER_TOKEN=... pnpm test:live
const token = process.env.ETRACKER_TOKEN;
const apiUrl = process.env.ETRACKER_API_URL ?? DEFAULT_API_URL;

describe.skipIf(!token)('live etracker API', () => {
  const client = new EtrackerClient({ apiUrl, token: token! });

  it('lists available reports', async () => {
    const reports = await client.request('/report');
    expect(reports).toBeTypeOf('object');
  });
});
