import { describe, expect, it, vi } from 'vitest';
import { EtrackerClient } from '../src/etracker-client.js';
import { tools } from '../src/tools.js';

function clientWithSpy() {
  const request = vi.fn(async () => ({ ok: true }));
  const client = { request } as unknown as EtrackerClient;
  return { client, request };
}

function tool(name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe('tools', () => {
  it('exposes the expected tool names', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'list_reports',
      'get_report_info',
      'get_report_metadata',
      'get_report_data',
      'compare_report_data',
    ]);
  });

  it('list_reports calls /report', async () => {
    const { client, request } = clientWithSpy();
    await tool('list_reports').handler(client, {});
    expect(request).toHaveBeenCalledWith('/report');
  });

  it('get_report_info encodes the report id', async () => {
    const { client, request } = clientWithSpy();
    await tool('get_report_info').handler(client, { reportId: 'EA Page' });
    expect(request).toHaveBeenCalledWith('/report/EA%20Page/info');
  });

  it('get_report_data serializes filters and forwards query params', async () => {
    const { client, request } = clientWithSpy();
    await tool('get_report_data').handler(client, {
      reportId: 'EAPage',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
      limit: 10,
      attributes: 'page_name',
      figures: 'unique_visits',
      attributeFilter: [
        { attributeId: 'page_name', input: ['Main'], filter: 'include', type: 'exact', filterType: 'extended' },
      ],
      keyfigureFilter: [{ keyfigure: 'unique_visits', input: 10, type: 'gt', filter: 'include' }],
    });

    expect(request).toHaveBeenCalledWith('/report/EAPage/data', {
      query: expect.objectContaining({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        limit: 10,
        attributes: 'page_name',
        figures: 'unique_visits',
        attributeFilter:
          '[{"attributeId":"page_name","input":["Main"],"filter":"include","type":"exact","filterType":"extended"}]',
        keyfigureFilter: '[{"keyfigure":"unique_visits","input":10,"type":"gt","filter":"include"}]',
      }),
    });
  });

  it('get_report_data validates sortOrder via the schema', () => {
    const parsed = tool('get_report_data').inputSchema.safeParse({
      reportId: 'EAPage',
      sortOrder: '3',
    });
    expect(parsed.success).toBe(false);
  });

  it('compare_report_data computes per-row deltas and defaults the previous range', async () => {
    const request = vi.fn(async (_path: string, init: { query: { startDate: string } }) => {
      if (init.query.startDate === '2024-05-08') {
        return [
          { id: 'a', page_name: 'A', visits: 100 },
          { id: 'b', page_name: 'B', visits: 50 },
        ];
      }
      return [
        { id: 'a', page_name: 'A', visits: 80 },
        { id: 'c', page_name: 'C', visits: 30 },
      ];
    });
    const client = { request } as unknown as EtrackerClient;

    const result = (await tool('compare_report_data').handler(client, {
      reportId: 'EAPage',
      startDate: '2024-05-08',
      endDate: '2024-05-14',
      attributes: 'page_name',
      figures: 'visits',
    })) as {
      previous: { startDate: string; endDate: string };
      rows: Array<{ id: string; presence: string; figures: Record<string, { delta: number; pctChange: number | null }> }>;
    };

    // previous range auto-derived as the week before
    expect(result.previous).toEqual({ startDate: '2024-05-01', endDate: '2024-05-07' });
    expect(request).toHaveBeenCalledTimes(2);

    // sorted by absolute delta of "visits": b (+50), c (-30), a (+20)
    expect(result.rows.map((r) => r.id)).toEqual(['b', 'c', 'a']);

    const a = result.rows.find((r) => r.id === 'a')!;
    expect(a.presence).toBe('both');
    expect(a.figures.visits).toMatchObject({ delta: 20, pctChange: 25 });

    const b = result.rows.find((r) => r.id === 'b')!;
    expect(b.presence).toBe('new');
    expect(b.figures.visits).toMatchObject({ delta: 50, pctChange: null });

    const c = result.rows.find((r) => r.id === 'c')!;
    expect(c.presence).toBe('gone');
    expect(c.figures.visits).toMatchObject({ delta: -30, pctChange: -100 });
  });
});
