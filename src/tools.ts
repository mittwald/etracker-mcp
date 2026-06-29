import { z } from 'zod';
import { EtrackerClient, dateRange, previousRange } from './etracker-client.js';
import { logger } from './logger.js';

const reportIdShape = {
  reportId: z
    .string()
    .describe('etracker report ID, e.g. "EAPage" or "EADeviceType". Use list_reports to discover IDs.'),
};

const dateRangeShape = {
  startDate: z
    .string()
    .optional()
    .describe('Start date of the report data, format YYYY-MM-DD. Defaults to rangeDays before endDate.'),
  endDate: z
    .string()
    .optional()
    .describe('End date of the report data, format YYYY-MM-DD. Defaults to today.'),
  rangeDays: z
    .number()
    .int()
    .positive()
    .max(366)
    .optional()
    .describe('Convenience: range length in days when startDate is omitted.'),
};

const attributeFilterSchema = z
  .array(
    z.object({
      attributeId: z.string().describe('ID of the attribute to filter.'),
      input: z.array(z.string()).describe('Substrings/values to match.'),
      filter: z.enum(['include', 'exclude']),
      type: z.enum(['contains', 'exact', 'regex']),
      filterType: z.literal('extended').default('extended'),
    }),
  )
  .optional()
  .describe('Attribute (dimension) filters applied to the report.');

const keyfigureFilterSchema = z
  .array(
    z.object({
      keyfigure: z.string().describe('ID of the keyfigure to filter.'),
      input: z.number().describe('Numeric value used for comparison.'),
      type: z.enum(['lt', 'gt', 'eq']).describe('lt = less than, gt = greater than, eq = equals.'),
      filter: z.enum(['include', 'exclude']),
    }),
  )
  .optional()
  .describe('Keyfigure (metric) filters applied to the report.');

const dataQueryShape = {
  limit: z.number().int().positive().optional().describe('Maximum number of rows to return.'),
  offset: z.number().int().nonnegative().optional().describe('Row offset for paging.'),
  sortColumn: z.string().optional().describe('Column ID used for sorting.'),
  sortOrder: z.enum(['1', '2']).optional().describe("'1' for descending, '2' for ascending."),
  attributes: z
    .string()
    .optional()
    .describe('Comma-separated list of attribute IDs to return, e.g. "page_name,url".'),
  figures: z
    .string()
    .optional()
    .describe('Comma-separated list of keyfigure IDs to return, e.g. "page_impressions,unique_visits".'),
  attributeFilter: attributeFilterSchema,
  keyfigureFilter: keyfigureFilterSchema,
};

type AttributeFilter = z.infer<typeof attributeFilterSchema>;
type KeyfigureFilter = z.infer<typeof keyfigureFilterSchema>;

type DataParams = {
  limit?: number;
  offset?: number;
  sortColumn?: string;
  sortOrder?: string;
  attributes?: string;
  figures?: string;
  attributeFilter?: AttributeFilter;
  keyfigureFilter?: KeyfigureFilter;
};

function serializeFilter(filter: AttributeFilter | KeyfigureFilter): string | undefined {
  return filter && filter.length > 0 ? JSON.stringify(filter) : undefined;
}

function dataQuery(params: DataParams, range: { startDate?: string; endDate?: string }) {
  return {
    ...range,
    limit: params.limit,
    offset: params.offset,
    sortColumn: params.sortColumn,
    sortOrder: params.sortOrder,
    attributes: params.attributes,
    figures: params.figures,
    attributeFilter: serializeFilter(params.attributeFilter),
    keyfigureFilter: serializeFilter(params.keyfigureFilter),
  };
}

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (client: EtrackerClient, args: Record<string, unknown>) => Promise<unknown>;
};

// --- compare_report_data helpers ---

type Row = Record<string, string | number | null>;

type FigureDiff = {
  current: number;
  previous: number;
  delta: number;
  /** Percentage change vs. the previous period; null when previous is 0. */
  pctChange: number | null;
};

type DiffRow = {
  id: string | number | null;
  attributes: Record<string, string | number | null>;
  /** "both" = present in both periods, "new" = only current, "gone" = only previous. */
  presence: 'both' | 'new' | 'gone';
  figures: Record<string, FigureDiff>;
};

function toNum(value: string | number | null | undefined): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Zero-width and bidirectional/format characters that etracker sometimes embeds
// in attribute values (e.g. a U+2063 INVISIBLE SEPARATOR prepended to a
// page_name by the tracked page's JS). They are invisible yet split one logical
// entity into two rows; stripping them lets those rows collapse into one.
const INVISIBLE_CHARS = new RegExp(
  '[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]',
  'g',
);

function clean(value: string): string {
  return value.replace(INVISIBLE_CHARS, '');
}

function cleanRow(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'string' ? clean(v) : v;
  return out;
}

function parseList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Key a row by its cleaned attribute values, so invisible-character variants of
// the same entity collide. Falls back to the cleaned id when no attributes were
// requested. etracker already aggregates by the requested attributes, so this
// only merges rows it kept apart purely because of invisible characters.
function mergeKey(row: Row, attributeIds: string[]): string {
  if (attributeIds.length > 0) {
    return attributeIds.map((a) => clean(String(row[a] ?? ''))).join('');
  }
  if (row.id !== undefined && row.id !== null) return clean(String(row.id));
  return JSON.stringify(cleanRow(row));
}

// Strip invisible characters from string values and merge rows that become
// identical (by mergeKey), summing the given keyfigures. Returns the cleaned,
// de-duplicated rows and how many duplicate rows were merged away.
function dedupeRows(
  rows: Row[],
  figureIds: string[],
  attributeIds: string[],
): { rows: Row[]; merged: number } {
  const byKey = new Map<string, Row>();
  let merged = 0;
  for (const raw of rows) {
    const key = mergeKey(raw, attributeIds);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, cleanRow(raw));
    } else {
      merged++;
      for (const f of figureIds) existing[f] = toNum(existing[f]) + toNum(raw[f]);
    }
  }
  return { rows: [...byKey.values()], merged };
}

function diffRow(
  cur: Row | undefined,
  prev: Row | undefined,
  figureIds: string[],
  attributeIds: string[],
): DiffRow {
  const base = cur ?? prev ?? {};
  const attributes: Record<string, string | number | null> = {};
  for (const a of attributeIds) attributes[a] = base[a] ?? null;

  const figures: Record<string, FigureDiff> = {};
  for (const f of figureIds) {
    const current = toNum(cur?.[f]);
    const previous = toNum(prev?.[f]);
    const delta = current - previous;
    figures[f] = {
      current,
      previous,
      delta,
      pctChange: previous === 0 ? null : Math.round((delta / previous) * 1000) / 10,
    };
  }

  return {
    id: base.id ?? null,
    attributes,
    presence: cur ? (prev ? 'both' : 'new') : 'gone',
    figures,
  };
}

export const tools: ToolDefinition[] = [
  {
    name: 'list_reports',
    description:
      'List all available reports for the account. Returns a map of report ID to display name (e.g. {"EAPage":"Pages","EAGeo":"Geo"}). Call first to obtain report IDs.',
    inputSchema: z.object({}),
    handler: async (client) => client.request('/report'),
  },
  {
    name: 'get_report_info',
    description:
      'General information and metadata for a report: report id, create date, number of saved segments/views, and available attributes.',
    inputSchema: z.object({ ...reportIdShape }),
    handler: async (client, args) => {
      const { reportId } = args as { reportId: string };
      return client.request(`/report/${encodeURIComponent(reportId)}/info`);
    },
  },
  {
    name: 'get_report_metadata',
    description:
      'Column metadata for a report: id, label, type (attribute/keyfigure), and whether each column is sortable/filterable. Use this to learn valid attribute and figure IDs before calling get_report_data.',
    inputSchema: z.object({ ...reportIdShape }),
    handler: async (client, args) => {
      const { reportId } = args as { reportId: string };
      return client.request(`/report/${encodeURIComponent(reportId)}/metaData`);
    },
  },
  {
    name: 'get_report_data',
    description:
      'Fetch report data rows for a report. Supports date range, paging, sorting, column selection and filtering. Limited to 100,000 rows per response. Discover valid column IDs with get_report_metadata.',
    inputSchema: z.object({
      ...reportIdShape,
      ...dateRangeShape,
      ...dataQueryShape,
    }),
    handler: async (client, args) => {
      const { reportId, ...rest } = args as { reportId: string } & DataParams & {
        startDate?: string;
        endDate?: string;
        rangeDays?: number;
      };
      const range = dateRange(rest);
      const result = await client.request(`/report/${encodeURIComponent(reportId)}/data`, {
        query: dataQuery(rest, range),
      });

      // Collapse phantom duplicates caused by invisible characters in attribute
      // values. Merge (summing keyfigures) only when figures are known; otherwise
      // just strip the invisible characters so the values display cleanly.
      if (!Array.isArray(result)) return result;
      const rows = result as Row[];
      const figureIds = parseList(rest.figures);
      if (figureIds.length === 0) return rows.map(cleanRow);
      const { rows: deduped, merged } = dedupeRows(rows, figureIds, parseList(rest.attributes));
      if (merged > 0) {
        logger.info('merged invisible-character duplicate rows', { report: reportId, merged });
      }
      return deduped;
    },
  },
  {
    name: 'compare_report_data',
    description:
      'Compare a report across two periods and return per-row deltas. Fetches the current range and a comparison range, joins rows by id, and computes current/previous/delta/pctChange for each requested figure. When the previous range is omitted it defaults to the equally long period immediately before the current one. Rows are sorted by the absolute delta of the first figure (largest changes first) — ideal for spotting anomalies. Requires figures.',
    inputSchema: z.object({
      ...reportIdShape,
      ...dateRangeShape,
      ...dataQueryShape,
      figures: z
        .string()
        .describe('Comma-separated keyfigure IDs to compare, e.g. "page_impressions,unique_visits". Required.'),
      previousStartDate: z
        .string()
        .optional()
        .describe('Start of the comparison period, YYYY-MM-DD. Defaults to the period before the current range.'),
      previousEndDate: z
        .string()
        .optional()
        .describe('End of the comparison period, YYYY-MM-DD. Defaults to the day before the current start.'),
    }),
    handler: async (client, args) => {
      const { reportId, previousStartDate, previousEndDate, ...rest } = args as {
        reportId: string;
        previousStartDate?: string;
        previousEndDate?: string;
      } & DataParams & { startDate?: string; endDate?: string; rangeDays?: number; figures: string };

      const current = dateRange(rest);
      if (!current.startDate || !current.endDate) {
        throw new Error(
          'compare_report_data requires a current range: provide startDate and endDate (or endDate + rangeDays).',
        );
      }
      const previous =
        previousStartDate && previousEndDate
          ? { startDate: previousStartDate, endDate: previousEndDate }
          : previousRange(current.startDate, current.endDate);

      const path = `/report/${encodeURIComponent(reportId)}/data`;
      const [curRows, prevRows] = await Promise.all([
        client.request<Row[]>(path, { query: dataQuery(rest, current) }),
        client.request<Row[]>(path, { query: dataQuery(rest, previous) }),
      ]);

      if (!Array.isArray(curRows) || !Array.isArray(prevRows)) {
        throw new Error(
          'Expected JSON array rows from etracker but received a non-array response (CSV?). This report may not support JSON comparison.',
        );
      }

      const figureIds = parseList(rest.figures);
      const attributeIds = parseList(rest.attributes);

      // Collapse invisible-character phantom duplicates within each period before
      // joining, so the same logical entity isn't split across rows.
      const { rows: curClean, merged: curMerged } = dedupeRows(curRows, figureIds, attributeIds);
      const { rows: prevClean, merged: prevMerged } = dedupeRows(prevRows, figureIds, attributeIds);

      const prevByKey = new Map<string, Row>();
      for (const row of prevClean) prevByKey.set(mergeKey(row, attributeIds), row);

      const seen = new Set<string>();
      const rows: DiffRow[] = [];
      for (const cur of curClean) {
        const key = mergeKey(cur, attributeIds);
        seen.add(key);
        rows.push(diffRow(cur, prevByKey.get(key), figureIds, attributeIds));
      }
      for (const prev of prevClean) {
        const key = mergeKey(prev, attributeIds);
        if (!seen.has(key)) rows.push(diffRow(undefined, prev, figureIds, attributeIds));
      }

      const primary = figureIds[0];
      if (primary) {
        rows.sort(
          (a, b) => Math.abs(b.figures[primary].delta) - Math.abs(a.figures[primary].delta),
        );
      }

      const limited = typeof rest.limit === 'number' ? rows.slice(0, rest.limit) : rows;

      return {
        report: reportId,
        current,
        previous,
        figures: figureIds,
        mergedDuplicates: curMerged + prevMerged,
        rowCount: limited.length,
        rows: limited,
      };
    },
  },
];
