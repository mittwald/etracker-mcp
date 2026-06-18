import { describe, expect, it, vi } from 'vitest';
import { dateRange, EtrackerApiError, EtrackerClient, previousRange } from '../src/etracker-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('EtrackerClient', () => {
  it('sends the X-ET-Token header and builds the query string', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: '1' }]));
    const client = new EtrackerClient({
      apiUrl: 'https://ws.example.com/api/v7',
      token: 'secret',
      fetchImpl,
    });

    const result = await client.request('/report/EAPage/data', {
      query: { startDate: '2024-01-01', limit: 10, offset: undefined, attributes: '' },
    });

    expect(result).toEqual([{ id: '1' }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      'https://ws.example.com/api/v7/report/EAPage/data?startDate=2024-01-01&limit=10',
    );
    expect((init as RequestInit).headers).toMatchObject({ 'X-ET-Token': 'secret' });
  });

  it('returns raw text for non-JSON responses (e.g. CSV)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('a,b\n1,2', { status: 200, headers: { 'content-type': 'text/csv' } }),
    );
    const client = new EtrackerClient({ apiUrl: 'https://x', token: 't', fetchImpl });
    expect(await client.request('/report')).toBe('a,b\n1,2');
  });

  it('throws EtrackerApiError on non-ok responses', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ errorCode: 401, msg: 'invalid token' }), { status: 401 }),
    );
    const client = new EtrackerClient({ apiUrl: 'https://x', token: 't', fetchImpl });
    await expect(client.request('/report')).rejects.toBeInstanceOf(EtrackerApiError);
  });
});

describe('dateRange', () => {
  it('passes through explicit dates', () => {
    expect(dateRange({ startDate: '2024-01-01', endDate: '2024-01-31' })).toEqual({
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    });
  });

  it('computes start from rangeDays relative to endDate', () => {
    expect(dateRange({ endDate: '2024-01-31', rangeDays: 7 })).toEqual({
      startDate: '2024-01-24',
      endDate: '2024-01-31',
    });
  });

  it('leaves both undefined when nothing is provided', () => {
    expect(dateRange({})).toEqual({ startDate: undefined, endDate: undefined });
  });
});

describe('previousRange', () => {
  it('returns the equally long period immediately before the range', () => {
    expect(previousRange('2024-05-08', '2024-05-14')).toEqual({
      startDate: '2024-05-01',
      endDate: '2024-05-07',
    });
  });

  it('handles a single-day range', () => {
    expect(previousRange('2024-05-08', '2024-05-08')).toEqual({
      startDate: '2024-05-07',
      endDate: '2024-05-07',
    });
  });
});
