import Papa from 'papaparse';
import * as XLSX from 'xlsx';

export type PandasDType = 'float64' | 'int64' | 'object' | 'bool' | 'datetime64[ns]';

export interface HistogramBin {
  binStart: number;
  binEnd: number;
  label: string;
  count: number;
  density: number;
}

export interface CategoryFreq {
  value: string;
  count: number;
  pct: number;
}

export interface NumericStats {
  count: number;
  mean: number;
  std: number;
  min: number;
  q25: number;
  median: number;
  q75: number;
  max: number;
  iqr: number;
  lowerBound: number;
  upperBound: number;
  outlierCount: number;
  outlierPct: number;
  skewness: number;
  histogram: HistogramBin[];
}

export interface ColumnProfile {
  name: string;
  dtype: PandasDType;
  nonNullCount: number;
  missingCount: number;
  missingPct: number;
  uniqueCount: number;
  sampleValues: string[];
  numeric?: NumericStats;
  topCategories?: CategoryFreq[];
  mode?: string;
}

export interface CorrelationPair {
  colA: string;
  colB: string;
  r: number;
}

export interface BivariateScatter {
  xCol: string;
  yCol: string;
  r: number;
  slope: number;
  intercept: number;
  points: { x: number; y: number; group?: string }[];
}

export interface GroupedDistribution {
  catCol: string;
  numCol: string;
  groups: {
    category: string;
    count: number;
    mean: number;
    min: number;
    q25: number;
    median: number;
    q75: number;
    max: number;
  }[];
}

export interface DataFrameProfile {
  fileName: string;
  source: 'upload' | 'google_drive' | 'sample';
  rowCount: number;
  colCount: number;
  originalRowCount: number;
  originalColCount: number;
  memoryBytes: number;
  duplicateRowCount: number;
  totalMissingCells: number;
  totalMissingPct: number;
  totalOutliersCount: number;
  columns: ColumnProfile[];
  headRows: Record<string, any>[];
  correlationMatrix: {
    columns: string[];
    matrix: number[][];
    topPairs: CorrelationPair[];
  };
  bivariateScatters: BivariateScatter[];
  groupedDistributions: GroupedDistribution[];
  transformationLog: string[];
  dtypeOverrides?: Record<string, PandasDType>;
}

export interface DataFrameState {
  rows: Record<string, any>[];
  profile: DataFrameProfile;
}

function isMissing(val: any): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === 'number' && Number.isNaN(val)) return true;
  if (typeof val === 'string') {
    const t = val.trim().toLowerCase();
    return t === '' || t === 'na' || t === 'n/a' || t === 'null' || t === 'nan' || t === 'none' || t === '?';
  }
  return false;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function isTemporalOrYearColumnName(colName: string, nonNullValues: any[]): boolean {
  const clean = colName.trim().toLowerCase();
  if (!clean) return false;

  // Exclude duration/count metrics like "years_of_experience", "tenure_years", "age_years"
  if (/(years_of|experience|tenure|age|service_years|years_at|years_since|years_in)/i.test(clean)) {
    return false;
  }

  // Exact match or clear temporal/year column name
  if (
    /^(year|yr|calendar_year|fiscal_year|release_year|model_year|birth_year|built_year|year_built|yr_built|yr_renovated|date|datetime|timestamp|order_date|created_at|updated_at)$/i.test(
      clean
    )
  ) {
    return true;
  }

  // Token match for year/date combined with plausible 4-digit year values (1700..2150)
  if (/(^|[_\-\s])(year|yr|date|datetime|timestamp)($|[_\-\s])/i.test(clean)) {
    const sample = nonNullValues.slice(0, 30);
    if (sample.length > 0) {
      const yearLikeCount = sample.filter((v) => {
        const n = Number(String(v).trim());
        return Number.isInteger(n) && n >= 1700 && n <= 2150;
      }).length;
      if (yearLikeCount / sample.length >= 0.7) {
        return true;
      }
    }
    return true;
  }

  return false;
}

function detectColumnType(
  values: any[],
  colName = '',
  dtypeOverrides?: Record<string, PandasDType>
): PandasDType {
  if (colName && dtypeOverrides && dtypeOverrides[colName]) {
    return dtypeOverrides[colName];
  }

  const nonNull = values.filter((v) => !isMissing(v));
  if (nonNull.length === 0) return 'object';

  if (colName && isTemporalOrYearColumnName(colName, nonNull)) {
    return 'datetime64[ns]';
  }

  let boolCount = 0;
  let numCount = 0;
  let intCount = 0;
  let dateCount = 0;

  for (const v of nonNull) {
    if (typeof v === 'boolean') {
      boolCount++;
      continue;
    }
    const str = String(v).trim();
    const lower = str.toLowerCase();
    if (lower === 'true' || lower === 'false') {
      boolCount++;
      continue;
    }
    const num = Number(str.replace(/,/g, ''));
    if (!Number.isNaN(num) && str !== '') {
      numCount++;
      if (Number.isInteger(num)) intCount++;
      continue;
    }
    // Check ISO or common date format
    if (/^\d{4}-\d{2}-\d{2}/.test(str) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(str)) {
      const parsed = Date.parse(str);
      if (!Number.isNaN(parsed)) {
        dateCount++;
      }
    }
  }

  const total = nonNull.length;
  if (boolCount / total >= 0.9) return 'bool';
  if (dateCount / total >= 0.85) return 'datetime64[ns]';
  if (numCount / total >= 0.85) {
    return intCount === numCount ? 'int64' : 'float64';
  }
  return 'object';
}

export function computeDataFrameProfile(
  rows: Record<string, any>[],
  fileName: string,
  source: 'upload' | 'google_drive' | 'sample',
  originalRowCount?: number,
  originalColCount?: number,
  transformationLog: string[] = [],
  dtypeOverrides?: Record<string, PandasDType>
): DataFrameProfile {
  const rowCount = rows.length;
  const colNames = rowCount > 0 ? Object.keys(rows[0]) : [];
  const colCount = colNames.length;

  // Duplicate rows detection
  const seenHashes = new Set<string>();
  let duplicateRowCount = 0;
  for (const r of rows) {
    const key = colNames.map((c) => (isMissing(r[c]) ? '__NULL__' : String(r[c]).trim())).join('||');
    if (seenHashes.has(key)) {
      duplicateRowCount++;
    } else {
      seenHashes.add(key);
    }
  }

  let totalMissingCells = 0;
  let totalOutliersCount = 0;

  const columns: ColumnProfile[] = colNames.map((colName) => {
    const rawVals = rows.map((r) => r[colName]);
    const dtype = detectColumnType(rawVals, colName, dtypeOverrides);

    const nonNullVals = rawVals.filter((v) => !isMissing(v));
    const nonNullCount = nonNullVals.length;
    const missingCount = rowCount - nonNullCount;
    totalMissingCells += missingCount;
    const missingPct = rowCount > 0 ? Number(((missingCount / rowCount) * 100).toFixed(2)) : 0;

    const uniqueSet = new Set(nonNullVals.map((v) => String(v).trim()));
    const uniqueCount = uniqueSet.size;
    const sampleValues = Array.from(uniqueSet).slice(0, 5);

    if (dtype === 'float64' || dtype === 'int64') {
      const nums = nonNullVals
        .map((v) => (typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''))))
        .filter((n) => !Number.isNaN(n));
      const sorted = [...nums].sort((a, b) => a - b);
      const n = sorted.length;

      if (n > 0) {
        const sum = sorted.reduce((acc, val) => acc + val, 0);
        const mean = sum / n;
        const variance = n > 1 ? sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (n - 1) : 0;
        const std = Math.sqrt(variance);
        const min = sorted[0];
        const q25 = quantile(sorted, 0.25);
        const median = quantile(sorted, 0.5);
        const q75 = quantile(sorted, 0.75);
        const max = sorted[n - 1];
        const iqr = q75 - q25;
        const lowerBound = q25 - 1.5 * iqr;
        const upperBound = q75 + 1.5 * iqr;

        const outliers = sorted.filter((val) => val < lowerBound || val > upperBound);
        const outlierCount = outliers.length;
        totalOutliersCount += outlierCount;
        const outlierPct = Number(((outlierCount / n) * 100).toFixed(2));

        // Skewness
        let skewness = 0;
        if (n > 2 && std > 0) {
          const m3 = sorted.reduce((acc, val) => acc + Math.pow((val - mean) / std, 3), 0);
          skewness = Number(((n / ((n - 1) * (n - 2))) * m3).toFixed(3));
        }

        // Histogram bins (12 bins)
        const binCount = Math.min(12, Math.max(5, Math.ceil(Math.sqrt(n))));
        const range = max - min || 1;
        const binWidth = range / binCount;
        const histogram: HistogramBin[] = Array.from({ length: binCount }, (_, idx) => {
          const binStart = min + idx * binWidth;
          const binEnd = idx === binCount - 1 ? max : min + (idx + 1) * binWidth;
          return {
            binStart: Number(binStart.toFixed(2)),
            binEnd: Number(binEnd.toFixed(2)),
            label: `${binStart.toFixed(1)}`,
            count: 0,
            density: 0,
          };
        });

        for (const val of sorted) {
          let idx = Math.floor((val - min) / binWidth);
          if (idx >= binCount) idx = binCount - 1;
          if (idx < 0) idx = 0;
          histogram[idx].count++;
        }
        for (const bin of histogram) {
          bin.density = Number((bin.count / n).toFixed(4));
        }

        return {
          name: colName,
          dtype,
          nonNullCount,
          missingCount,
          missingPct,
          uniqueCount,
          sampleValues,
          mode: String(median),
          numeric: {
            count: n,
            mean: Number(mean.toFixed(4)),
            std: Number(std.toFixed(4)),
            min: Number(min.toFixed(4)),
            q25: Number(q25.toFixed(4)),
            median: Number(median.toFixed(4)),
            q75: Number(q75.toFixed(4)),
            max: Number(max.toFixed(4)),
            iqr: Number(iqr.toFixed(4)),
            lowerBound: Number(lowerBound.toFixed(4)),
            upperBound: Number(upperBound.toFixed(4)),
            outlierCount,
            outlierPct,
            skewness,
            histogram,
          },
        };
      }
    }

    // Categorical / Object / Bool frequencies
    const counts = new Map<string, number>();
    for (const v of nonNullVals) {
      const key = String(v).trim();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const sortedCats: CategoryFreq[] = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value, count]) => ({
        value,
        count,
        pct: nonNullCount > 0 ? Number(((count / nonNullCount) * 100).toFixed(1)) : 0,
      }));

    return {
      name: colName,
      dtype,
      nonNullCount,
      missingCount,
      missingPct,
      uniqueCount,
      sampleValues,
      topCategories: sortedCats,
      mode: sortedCats[0]?.value || '',
    };
  });

  // Compute Pearson correlation matrix for numeric columns
  const numericCols = columns.filter((c) => c.numeric !== undefined).map((c) => c.name);
  const matrix: number[][] = [];
  const topPairs: CorrelationPair[] = [];

  for (let i = 0; i < numericCols.length; i++) {
    matrix[i] = [];
    for (let j = 0; j < numericCols.length; j++) {
      if (i === j) {
        matrix[i][j] = 1;
        continue;
      }
      if (j < i) {
        matrix[i][j] = matrix[j][i];
        continue;
      }
      const colA = numericCols[i];
      const colB = numericCols[j];
      const pairs: [number, number][] = [];
      for (const r of rows) {
        const va = r[colA];
        const vb = r[colB];
        if (!isMissing(va) && !isMissing(vb)) {
          const na = typeof va === 'number' ? va : Number(String(va).replace(/,/g, ''));
          const nb = typeof vb === 'number' ? vb : Number(String(vb).replace(/,/g, ''));
          if (!Number.isNaN(na) && !Number.isNaN(nb)) {
            pairs.push([na, nb]);
          }
        }
      }

      if (pairs.length < 3) {
        matrix[i][j] = 0;
      } else {
        const meanA = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
        const meanB = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
        let num = 0;
        let denA = 0;
        let denB = 0;
        for (const [a, b] of pairs) {
          const da = a - meanA;
          const db = b - meanB;
          num += da * db;
          denA += da * da;
          denB += db * db;
        }
        const denom = Math.sqrt(denA * denB);
        const r = denom === 0 ? 0 : Number((num / denom).toFixed(4));
        matrix[i][j] = r;
        topPairs.push({ colA, colB, r });
      }
    }
  }

  topPairs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  // Build Bivariate Scatter Data for top 4 correlated numeric pairs
  const catColForHue = columns.find(
    (c) => (c.dtype === 'object' || c.dtype === 'bool') && c.uniqueCount >= 2 && c.uniqueCount <= 6
  )?.name;

  const bivariateScatters: BivariateScatter[] = topPairs.slice(0, 4).map((pair) => {
    const pts: { x: number; y: number; group?: string }[] = [];
    const maxPts = 180;
    const step = Math.max(1, Math.floor(rows.length / maxPts));
    for (let idx = 0; idx < rows.length && pts.length < maxPts; idx += step) {
      const r = rows[idx];
      const va = r[pair.colA];
      const vb = r[pair.colB];
      if (!isMissing(va) && !isMissing(vb)) {
        const na = typeof va === 'number' ? va : Number(String(va).replace(/,/g, ''));
        const nb = typeof vb === 'number' ? vb : Number(String(vb).replace(/,/g, ''));
        if (!Number.isNaN(na) && !Number.isNaN(nb)) {
          pts.push({
            x: Number(na.toFixed(3)),
            y: Number(nb.toFixed(3)),
            group: catColForHue && !isMissing(r[catColForHue]) ? String(r[catColForHue]) : undefined,
          });
        }
      }
    }

    // Linear regression line y = slope * x + intercept
    let slope = 0;
    let intercept = 0;
    if (pts.length >= 2) {
      const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      let num = 0;
      let den = 0;
      for (const p of pts) {
        num += (p.x - mx) * (p.y - my);
        den += (p.x - mx) * (p.x - mx);
      }
      slope = den === 0 ? 0 : num / den;
      intercept = my - slope * mx;
    }

    return {
      xCol: pair.colA,
      yCol: pair.colB,
      r: pair.r,
      slope: Number(slope.toFixed(4)),
      intercept: Number(intercept.toFixed(4)),
      points: pts,
    };
  });

  // Build Grouped Distributions (Categorical vs Numeric)
  const groupedDistributions: GroupedDistribution[] = [];
  const candidateCats = columns.filter(
    (c) => (c.dtype === 'object' || c.dtype === 'bool') && c.uniqueCount >= 2 && c.uniqueCount <= 8
  );
  const candidateNums = columns.filter((c) => c.numeric !== undefined);

  if (candidateCats.length > 0 && candidateNums.length > 0) {
    for (let i = 0; i < Math.min(2, candidateCats.length); i++) {
      const catCol = candidateCats[i].name;
      const numCol = candidateNums[i % candidateNums.length].name;
      const map = new Map<string, number[]>();
      for (const r of rows) {
        if (!isMissing(r[catCol]) && !isMissing(r[numCol])) {
          const k = String(r[catCol]).trim();
          const n = typeof r[numCol] === 'number' ? r[numCol] : Number(String(r[numCol]).replace(/,/g, ''));
          if (!Number.isNaN(n)) {
            if (!map.has(k)) map.set(k, []);
            map.get(k)!.push(n);
          }
        }
      }

      const groups = Array.from(map.entries())
        .filter(([, arr]) => arr.length > 0)
        .slice(0, 6)
        .map(([category, arr]) => {
          const s = [...arr].sort((a, b) => a - b);
          const mean = s.reduce((acc, v) => acc + v, 0) / s.length;
          return {
            category,
            count: s.length,
            mean: Number(mean.toFixed(2)),
            min: Number(s[0].toFixed(2)),
            q25: Number(quantile(s, 0.25).toFixed(2)),
            median: Number(quantile(s, 0.5).toFixed(2)),
            q75: Number(quantile(s, 0.75).toFixed(2)),
            max: Number(s[s.length - 1].toFixed(2)),
          };
        });

      if (groups.length >= 2) {
        groupedDistributions.push({ catCol, numCol, groups });
      }
    }
  }

  const totalCells = rowCount * colCount || 1;
  const totalMissingPct = Number(((totalMissingCells / totalCells) * 100).toFixed(2));
  const memoryBytes = rowCount * colCount * 8 + 128;

  return {
    fileName,
    source,
    rowCount,
    colCount,
    originalRowCount: originalRowCount ?? rowCount,
    originalColCount: originalColCount ?? colCount,
    memoryBytes,
    duplicateRowCount,
    totalMissingCells,
    totalMissingPct,
    totalOutliersCount,
    columns,
    headRows: rows.slice(0, 8),
    correlationMatrix: {
      columns: numericCols,
      matrix,
      topPairs: topPairs.slice(0, 10),
    },
    bivariateScatters,
    groupedDistributions,
    transformationLog,
    dtypeOverrides,
  };
}

export function overrideColumnDType(
  state: DataFrameState,
  colName: string,
  newDType: PandasDType
): DataFrameState {
  const { rows, profile } = state;
  const nextOverrides: Record<string, PandasDType> = {
    ...(profile.dtypeOverrides || {}),
    [colName]: newDType,
  };
  const convSnippet =
    newDType === 'datetime64[ns]'
      ? `pd.to_datetime(df['${colName}'].astype(str), format='%Y', errors='coerce')`
      : `df['${colName}'].astype('${newDType}')`;
  const logs = [
    ...profile.transformationLog,
    `Revised variable '${colName}' data type to ${newDType} (${convSnippet}).`,
  ];

  return {
    rows,
    profile: computeDataFrameProfile(
      rows,
      profile.fileName,
      profile.source,
      profile.originalRowCount,
      profile.originalColCount,
      logs,
      nextOverrides
    ),
  };
}

export function refreshDataFrameProfileTypes(state: DataFrameState): DataFrameState {
  const { rows, profile } = state;
  return {
    rows,
    profile: computeDataFrameProfile(
      rows,
      profile.fileName,
      profile.source,
      profile.originalRowCount,
      profile.originalColCount,
      profile.transformationLog,
      profile.dtypeOverrides
    ),
  };
}

export async function parseDatasetBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  source: 'upload' | 'google_drive' | 'sample'
): Promise<DataFrameState> {
  const lower = fileName.toLowerCase();
  let rows: Record<string, any>[] = [];

  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      throw new Error('The Excel workbook contains no sheets.');
    }
    const worksheet = workbook.Sheets[firstSheetName];
    rows = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet, { defval: null });
  } else {
    const text = new TextDecoder('utf-8').decode(buffer);
    const parsed = Papa.parse<Record<string, any>>(text, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
    });
    rows = parsed.data || [];
  }

  if (rows.length === 0) {
    throw new Error('No tabular rows were found in the uploaded file.');
  }

  const profile = computeDataFrameProfile(rows, fileName, source, rows.length, Object.keys(rows[0]).length, [
    `Loaded '${fileName}' into Pandas DataFrame (${rows.length} rows × ${Object.keys(rows[0]).length} columns).`,
  ]);

  return { rows, profile };
}

export function applyMissingValueStrategy(
  state: DataFrameState,
  strategy: 'impute_median_mode' | 'drop_rows' | 'drop_high_missing_cols'
): DataFrameState {
  const { rows, profile } = state;
  let newRows = rows.map((r) => ({ ...r }));
  const logs = [...profile.transformationLog];

  if (strategy === 'drop_rows') {
    const before = newRows.length;
    const colNames = profile.columns.map((c) => c.name);
    newRows = newRows.filter((r) => colNames.every((c) => !isMissing(r[c])));
    logs.push(`Step 3: Dropped ${before - newRows.length} rows containing missing values (df.dropna()).`);
  } else if (strategy === 'drop_high_missing_cols') {
    const colsToDrop = profile.columns.filter((c) => c.missingPct > 30).map((c) => c.name);
    if (colsToDrop.length > 0) {
      for (const r of newRows) {
        for (const c of colsToDrop) {
          delete r[c];
        }
      }
      logs.push(`Step 3: Dropped high-missingness columns (>30% missing): ${colsToDrop.join(', ')}.`);
    }
    // Impute remaining with median/mode
    const remainingCols = profile.columns.filter((c) => !colsToDrop.includes(c.name) && c.missingCount > 0);
    for (const col of remainingCols) {
      const fillVal = col.numeric ? col.numeric.median : col.mode || 'Unknown';
      for (const r of newRows) {
        if (isMissing(r[col.name])) {
          r[col.name] = fillVal;
        }
      }
      logs.push(`Step 3: Imputed '${col.name}' (${col.missingCount} missing) with ${col.numeric ? `median (${fillVal})` : `mode ('${fillVal}')`}.`);
    }
  } else {
    // Impute numeric with median, categorical with mode
    const colsWithMissing = profile.columns.filter((c) => c.missingCount > 0);
    for (const col of colsWithMissing) {
      const fillVal = col.numeric ? col.numeric.median : col.mode || 'Unknown';
      for (const r of newRows) {
        if (isMissing(r[col.name])) {
          r[col.name] = fillVal;
        }
      }
      logs.push(
        `Step 3: Imputed '${col.name}' (${col.missingCount} missing, ${col.missingPct}%) with ${
          col.numeric ? `median = ${fillVal}` : `mode = '${fillVal}'`
        }.`
      );
    }
  }

  return {
    rows: newRows,
    profile: computeDataFrameProfile(
      newRows,
      profile.fileName,
      profile.source,
      profile.originalRowCount,
      profile.originalColCount,
      logs,
      profile.dtypeOverrides
    ),
  };
}

export function applyDuplicateAndOutlierCleaning(
  state: DataFrameState,
  mode: 'deduplicate_only' | 'clip_iqr_and_dedup' | 'remove_iqr_and_dedup'
): DataFrameState {
  const { rows, profile } = state;
  const colNames = profile.columns.map((c) => c.name);
  const logs = [...profile.transformationLog];

  // 1. Deduplicate
  const seen = new Set<string>();
  let newRows: Record<string, any>[] = [];
  let removedDups = 0;
  for (const r of rows) {
    const key = colNames.map((c) => (isMissing(r[c]) ? '__NULL__' : String(r[c]).trim())).join('||');
    if (seen.has(key)) {
      removedDups++;
    } else {
      seen.add(key);
      newRows.push({ ...r });
    }
  }
  if (removedDups > 0) {
    logs.push(`Step 4: Removed ${removedDups} exact duplicate rows via df.drop_duplicates().`);
  }

  // 2. Outliers via IQR
  if (mode === 'clip_iqr_and_dedup') {
    let clippedCount = 0;
    for (const col of profile.columns) {
      if (col.numeric && col.numeric.outlierCount > 0) {
        const { lowerBound, upperBound } = col.numeric;
        for (const r of newRows) {
          const v = r[col.name];
          if (!isMissing(v)) {
            const num = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
            if (!Number.isNaN(num)) {
              if (num < lowerBound) {
                r[col.name] = lowerBound;
                clippedCount++;
              } else if (num > upperBound) {
                r[col.name] = upperBound;
                clippedCount++;
              }
            }
          }
        }
      }
    }
    logs.push(`Step 4: Clipped ${clippedCount} extreme values to 1.5×IQR fences ([Q1 - 1.5*IQR, Q3 + 1.5*IQR]).`);
  } else if (mode === 'remove_iqr_and_dedup') {
    const before = newRows.length;
    const numCols = profile.columns.filter((c) => c.numeric && c.numeric.outlierCount > 0);
    newRows = newRows.filter((r) =>
      numCols.every((col) => {
        const v = r[col.name];
        if (isMissing(v)) return true;
        const num = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
        return num >= col.numeric!.lowerBound && num <= col.numeric!.upperBound;
      })
    );
    logs.push(`Step 4: Filtered out ${before - newRows.length} rows exceeding 1.5×IQR outlier bounds.`);
  }

  return {
    rows: newRows,
    profile: computeDataFrameProfile(
      newRows,
      profile.fileName,
      profile.source,
      profile.originalRowCount,
      profile.originalColCount,
      logs,
      profile.dtypeOverrides
    ),
  };
}

export function applyDataTransformation(
  state: DataFrameState,
  mode: 'log_skewed' | 'label_encode_cats' | 'standardize_numeric'
): DataFrameState {
  const { rows, profile } = state;
  const newRows = rows.map((r) => ({ ...r }));
  const logs = [...profile.transformationLog];

  if (mode === 'log_skewed') {
    const skewedCols = profile.columns.filter(
      (c) => c.numeric && Math.abs(c.numeric.skewness) > 0.75 && c.numeric.min >= 0
    );
    for (const col of skewedCols) {
      const newColName = `${col.name}_log1p`;
      for (const r of newRows) {
        const v = r[col.name];
        if (!isMissing(v)) {
          const num = Number(v);
          r[newColName] = Number(Math.log1p(Math.max(0, num)).toFixed(4));
        } else {
          r[newColName] = null;
        }
      }
      logs.push(`Step 5: Created log-transformed feature '${newColName}' via np.log1p(df['${col.name}']) (skewness = ${col.numeric?.skewness}).`);
    }
  } else if (mode === 'label_encode_cats') {
    const catCols = profile.columns.filter(
      (c) => (c.dtype === 'object' || c.dtype === 'bool') && c.uniqueCount >= 2 && c.uniqueCount <= 12
    );
    for (const col of catCols) {
      const mapping = new Map<string, number>();
      let code = 0;
      for (const cat of col.topCategories || []) {
        mapping.set(cat.value, code++);
      }
      const encodedName = `${col.name}_code`;
      for (const r of newRows) {
        const v = isMissing(r[col.name]) ? '' : String(r[col.name]).trim();
        r[encodedName] = mapping.has(v) ? mapping.get(v)! : -1;
      }
      logs.push(`Step 5: Encoded categorical column '${col.name}' -> '${encodedName}' (${mapping.size} distinct classes).`);
    }
  } else if (mode === 'standardize_numeric') {
    const numCols = profile.columns.filter((c) => c.numeric && c.numeric.std > 0).slice(0, 4);
    for (const col of numCols) {
      const { mean, std } = col.numeric!;
      const zName = `${col.name}_zscore`;
      for (const r of newRows) {
        const v = r[col.name];
        if (!isMissing(v)) {
          r[zName] = Number(((Number(v) - mean) / std).toFixed(4));
        } else {
          r[zName] = null;
        }
      }
      logs.push(`Step 5: Standardized '${col.name}' -> '${zName}' (Z-score μ=0, σ=1).`);
    }
  }

  return {
    rows: newRows,
    profile: computeDataFrameProfile(
      newRows,
      profile.fileName,
      profile.source,
      profile.originalRowCount,
      profile.originalColCount,
      logs,
      profile.dtypeOverrides
    ),
  };
}

export function exportDataFrameToCSV(state: DataFrameState): string {
  return Papa.unparse(state.rows);
}

export function generatePythonSnippetForStep(step: number, p: DataFrameProfile): { code: string; stdout: string } {
  const numCols = p.columns.filter((c) => c.numeric).map((c) => `'${c.name}'`);
  const dtCols = p.columns.filter((c) => c.dtype === 'datetime64[ns]').map((c) => `'${c.name}'`);
  const catCols = p.columns
    .filter((c) => !c.numeric && c.dtype !== 'datetime64[ns]')
    .map((c) => `'${c.name}'`);
  const dtConvertLines = p.columns
    .filter((c) => c.dtype === 'datetime64[ns]')
    .map((c) => `df['${c.name}'] = pd.to_datetime(df['${c.name}'].astype(str), errors='coerce')`)
    .join('\n');

  switch (step) {
    case 1:
      return {
        code: `import pandas as pd
import numpy as np

# Step 1: Load dataset and inspect high-level domain structure
df = pd.read_csv("${p.fileName}")${dtConvertLines ? `\n${dtConvertLines}` : ''}
print(f"Dataset loaded: {df.shape[0]} rows, {df.shape[1]} columns")
print("Numerical features:", [${numCols.join(', ')}])${
          dtCols.length > 0 ? `\nprint("Datetime features:", [${dtCols.join(', ')}])` : ''
        }
print("Categorical/Object features:", [${catCols.join(', ')}])`,
        stdout: `Dataset loaded: ${p.rowCount} rows, ${p.colCount} columns
Numerical features: [${numCols.join(', ')}]${
          dtCols.length > 0 ? `\nDatetime features: [${dtCols.join(', ')}]` : ''
        }
Categorical/Object features: [${catCols.join(', ')}]`,
      };
    case 2: {
      const infoLines = p.columns
        .map(
          (c, i) =>
            ` ${String(i).padStart(2, ' ')}  ${c.name.padEnd(22, ' ')} ${String(c.nonNullCount).padStart(5, ' ')} non-null   ${c.dtype}`
        )
        .join('\n');
      return {
        code: `# Step 2: Import and Inspect the Data (head, info, shape)
print("Shape:", df.shape)
print("\\n--- DataFrame Info ---")
df.info()
print("\\n--- First 5 Rows ---")
print(df.head(5))`,
        stdout: `Shape: (${p.rowCount}, ${p.colCount})

<class 'pandas.core.frame.DataFrame'>
RangeIndex: ${p.rowCount} entries, 0 to ${Math.max(0, p.rowCount - 1)}
Data columns (total ${p.colCount} columns):
 #   Column                 Non-Null Count  Dtype  
---  ------                 --------------  -----  
${infoLines}
memory usage: ${(p.memoryBytes / 1024).toFixed(1)} KB`,
      };
    }
    case 3: {
      const missingLines = p.columns
        .map((c) => `${c.name.padEnd(24, ' ')} ${String(c.missingCount).padStart(6, ' ')}    (${c.missingPct.toFixed(2)}%)`)
        .join('\n');
      return {
        code: `# Step 3: Handle Missing Values (Identify % missing, plot missingness, suggest fix)
import matplotlib.pyplot as plt
import seaborn as sns

missing_cnt = df.isnull().sum()
missing_pct = (df.isnull().sum() / len(df)) * 100
missing_df = pd.DataFrame({'Missing Count': missing_cnt, 'Missing %': missing_pct})
print(missing_df.sort_values(by='Missing %', ascending=False))

# Suggested imputation strategy:
# Numeric columns -> median imputation; Categorical columns -> mode imputation`,
        stdout: `Column                   Missing    Missing %
---------------------------------------------
${missingLines}
Total Missing Cells: ${p.totalMissingCells} (${p.totalMissingPct}%)`,
      };
    }
    case 4: {
      const outlierLines = p.columns
        .filter((c) => c.numeric)
        .map(
          (c) =>
            `${c.name.padEnd(20, ' ')} IQR=${c.numeric!.iqr.toFixed(2).padStart(8, ' ')} | Bounds=[${c.numeric!.lowerBound.toFixed(2)}, ${c.numeric!.upperBound.toFixed(2)}] | Outliers=${c.numeric!.outlierCount} (${c.numeric!.outlierPct}%)`
        )
        .join('\n');
      return {
        code: `# Step 4: Clean Duplicates and Anomalies (Find duplicates, detect outliers via IQR)
dup_count = df.duplicated().sum()
print(f"Exact Duplicate Rows: {dup_count}")

num_cols = df.select_dtypes(include=[np.number]).columns
for col in num_cols:
    Q1 = df[col].quantile(0.25)
    Q3 = df[col].quantile(0.75)
    IQR = Q3 - Q1
    lower, upper = Q1 - 1.5 * IQR, Q3 + 1.5 * IQR
    outliers = ((df[col] < lower) | (df[col] > upper)).sum()
    print(f"{col}: IQR={IQR:.2f}, Bounds=[{lower:.2f}, {upper:.2f}], Outliers={outliers}")`,
        stdout: `Exact Duplicate Rows: ${p.duplicateRowCount}
Total IQR Outliers Detected Across Numeric Features: ${p.totalOutliersCount}
-------------------------------------------------------------------------
${outlierLines || 'No numeric columns detected.'}`,
      };
    }
    case 5: {
      const skewLines = p.columns
        .filter((c) => c.numeric)
        .map((c) => `${c.name.padEnd(22, ' ')} dtype=${c.dtype.padEnd(8, ' ')} skewness=${c.numeric!.skewness.toFixed(3)}`)
        .join('\n');
      return {
        code: `# Step 5: Perform Data Transformation (Adjust data types, log-transform skewed, encode categoricals)
print("Current Data Types:\\n", df.dtypes)
skewness = df.select_dtypes(include=[np.number]).skew()
print("\\nNumerical Feature Skewness:\\n", skewness)

# Encode low-cardinality categorical features & log1p transform right-skewed columns (|skew| > 0.75)`,
        stdout: `Feature Skewness & Type Audit:
--------------------------------------------------
${skewLines || 'No numeric columns'}
Active Transformations Applied: ${p.transformationLog.length}`,
      };
    }
    case 6: {
      const descLines = p.columns
        .filter((c) => c.numeric)
        .map(
          (c) =>
            `${c.name.padEnd(18, ' ')} mean=${c.numeric!.mean.toFixed(2).padStart(8, ' ')} | std=${c.numeric!.std.toFixed(2).padStart(8, ' ')} | 50%=${c.numeric!.median.toFixed(2).padStart(8, ' ')} | min=${c.numeric!.min.toFixed(2)} | max=${c.numeric!.max.toFixed(2)}`
        )
        .join('\n');
      return {
        code: `# Step 6: Univariate Analysis (Summary stats, Histograms + KDE, Boxplots)
import matplotlib.pyplot as plt
import seaborn as sns

print(df.describe().T[['count', 'mean', 'std', 'min', '25%', '50%', '75%', 'max']])
fig, axes = plt.subplots(nrows=2, ncols=2, figsize=(12, 8))
for ax, col in zip(axes.flat, df.select_dtypes(include=[np.number]).columns[:4]):
    sns.histplot(df[col].dropna(), kde=True, ax=ax, color='#2563EB')
plt.tight_layout()`,
        stdout: `Univariate Summary Statistics (df.describe()):
----------------------------------------------------------------------------------
${descLines || 'No numeric columns'}`,
      };
    }
    case 7: {
      const pairLines = p.correlationMatrix.topPairs
        .slice(0, 6)
        .map((pair) => `${pair.colA} <-> ${pair.colB}: r = ${pair.r >= 0 ? '+' : ''}${pair.r.toFixed(4)}`)
        .join('\n');
      return {
        code: `# Step 7: Bivariate & Multivariate Analysis (Correlation matrix, Heatmap, Joint Scatter)
corr_matrix = df.select_dtypes(include=[np.number]).corr(method='pearson')
print("Top Feature Correlations (Pearson r):")
print(corr_matrix.round(3))

plt.figure(figsize=(10, 8))
sns.heatmap(corr_matrix, annot=True, cmap='coolwarm', vmin=-1, vmax=1, fmt='.2f')
plt.title('Multivariate Pearson Correlation Heatmap')`,
        stdout: `Top Bivariate Pearson Correlations:
--------------------------------------------------
${pairLines || 'Insufficient numeric pairs for correlation matrix.'}`,
      };
    }
    case 8:
    default:
      return {
        code: `# Step 8: Final Dashboard Summary & Clean Dataset Export
print(f"Final Cleaned Shape: {df.shape[0]} rows × {df.shape[1]} columns")
print(f"Remaining Missing Values: {df.isnull().sum().sum()}")
print(f"Remaining Duplicate Rows: {df.duplicated().sum()}")
df.to_csv("cleaned_${p.fileName}", index=False)`,
        stdout: `Final Cleaned Shape: ${p.rowCount} rows × ${p.colCount} columns (Initial: ${p.originalRowCount} × ${p.originalColCount})
Remaining Missing Values: ${p.totalMissingCells} (${p.totalMissingPct}%)
Remaining Duplicate Rows: ${p.duplicateRowCount}
Transformations Logged: ${p.transformationLog.length}`,
      };
  }
}

export const EDA_STEPS_META = [
  {
    step: 1,
    title: 'Understand the Problem and Data',
    shortTitle: 'Problem & Data',
    description: 'Establish domain context, dataset grain, target candidates, and feature taxonomy.',
    hasPlots: false,
  },
  {
    step: 2,
    title: 'Import and Inspect the Data',
    shortTitle: 'Import & Inspect',
    description: 'Examine df.head(), df.info(), df.shape, memory footprint, and schema types.',
    hasPlots: true,
  },
  {
    step: 3,
    title: 'Handle Missing Values',
    shortTitle: 'Missing Values',
    description: 'Quantify null percentages per column, visualize missingness, and apply imputation fixes.',
    hasPlots: true,
  },
  {
    step: 4,
    title: 'Clean Duplicates and Anomalies',
    shortTitle: 'Duplicates & IQR',
    description: 'Detect exact duplicate records and statistical outliers using 1.5×IQR fences.',
    hasPlots: false,
  },
  {
    step: 5,
    title: 'Perform Data Transformation',
    shortTitle: 'Transformation',
    description: 'Adjust data types, log-transform skewed distributions, and encode categoricals.',
    hasPlots: false,
  },
  {
    step: 6,
    title: 'Univariate Analysis',
    shortTitle: 'Univariate Stats',
    description: 'Compute summary statistics (describe), histograms, KDE curves, and boxplots.',
    hasPlots: true,
  },
  {
    step: 7,
    title: 'Bivariate & Multivariate Analysis',
    shortTitle: 'Correlations',
    description: 'Explore Pearson correlation heatmaps, scatter regressions, and grouped cohorts.',
    hasPlots: true,
  },
  {
    step: 8,
    title: 'Final Dashboard Summary',
    shortTitle: 'Final Dashboard',
    description: 'Consolidated executive synthesis, cleaned data audit, and multi-chart overview.',
    hasPlots: true,
  },
];

// Curated Benchmark Datasets with realistic missing values, duplicates, outliers, and correlations
export const SAMPLE_DATASETS: {
  id: string;
  name: string;
  fileName: string;
  domain: string;
  description: string;
  csvContent: string;
}[] = [
  {
    id: 'clinical_telemetry',
    name: 'Cardiovascular Clinical Telemetry',
    fileName: 'cardiovascular_clinical_cohort.csv',
    domain: 'Healthcare & Biostatistics',
    description: '120 patient records with ejection fraction, serum creatinine, age, blood pressure, missing lab entries, and IQR anomalies.',
    csvContent: `patient_id,age,sex,chest_pain_type,resting_bp,cholesterol,fasting_bs,max_heart_rate,ejection_fraction,serum_creatinine,smoking_status,heart_risk_event
P-1001,63,Male,Asymptomatic,145,233,1,150,38.5,1.9,Smoker,1
P-1002,37,Male,Non-Anginal,130,250,0,187,62.0,1.0,Never,0
P-1003,41,Female,Atypical,130,204,0,172,58.4,0.9,Never,0
P-1004,56,Male,Typical,120,236,0,178,54.2,1.1,Former,0
P-1005,57,Female,Asymptomatic,120,354,0,163,48.0,1.2,Smoker,1
P-1006,57,Male,Asymptomatic,140,192,0,148,44.5,,Former,0
P-1007,56,Female,Atypical,140,294,0,153,51.0,1.3,Never,0
P-1008,44,Male,Atypical,120,263,0,173,60.2,1.0,Never,0
P-1009,52,Male,Non-Anginal,172,199,1,162,41.0,1.6,Smoker,1
P-1010,57,Male,Non-Anginal,150,168,0,174,55.0,1.1,Former,0
P-1011,54,Male,Asymptomatic,140,239,0,160,47.8,1.2,Smoker,0
P-1012,48,Female,Non-Anginal,130,275,0,139,52.3,,Never,0
P-1013,49,Male,Atypical,130,266,0,171,59.1,0.9,Never,0
P-1014,64,Male,Typical,110,211,0,144,45.0,1.4,Former,1
P-1015,58,Female,Typical,150,283,1,162,49.5,1.1,Never,0
P-1016,50,Female,Non-Anginal,120,219,0,158,56.8,0.8,Never,0
P-1017,58,Female,Non-Anginal,120,340,0,172,53.0,1.0,Former,0
P-1018,66,Female,Typical,150,226,0,114,35.2,2.4,Smoker,1
P-1019,43,Male,Asymptomatic,150,247,0,171,57.0,1.1,Smoker,0
P-1020,69,Female,Typical,140,239,0,151,42.5,1.7,Former,1
P-1021,59,Male,Asymptomatic,135,234,0,161,46.0,1.3,Smoker,1
P-1022,44,Male,Non-Anginal,130,233,0,179,61.5,0.9,Never,0
P-1023,42,Male,Asymptomatic,140,226,0,178,63.0,0.9,Never,0
P-1024,61,Male,Non-Anginal,150,243,1,137,39.8,1.8,Smoker,1
P-1025,40,Male,Typical,140,199,0,178,64.0,1.0,Never,0
P-1026,71,Female,Atypical,160,302,0,162,43.0,1.5,Former,1
P-1027,59,Male,Non-Anginal,150,212,1,157,48.2,1.2,Former,0
P-1028,51,Male,Non-Anginal,110,175,0,123,50.0,1.1,Never,0
P-1029,65,Female,Non-Anginal,140,417,1,157,36.4,2.8,Smoker,1
P-1030,53,Male,Non-Anginal,130,197,1,152,52.0,1.1,Former,0
P-1031,41,Female,Atypical,105,198,0,168,61.0,0.8,Never,0
P-1032,65,Male,Asymptomatic,120,177,0,140,40.5,1.9,Smoker,1
P-1033,44,Male,Atypical,130,219,0,188,65.2,0.9,Never,0
P-1034,54,Male,Non-Anginal,125,273,0,152,49.0,1.2,Former,0
P-1035,51,Male,Typical,125,213,0,125,43.5,1.5,Smoker,1
P-1036,46,Female,Non-Anginal,142,177,0,160,55.5,,Never,0
P-1037,54,Female,Non-Anginal,135,304,1,170,51.2,1.0,Never,0
P-1038,54,Male,Typical,150,232,0,165,47.0,1.3,Smoker,1
P-1039,65,Female,Non-Anginal,155,269,0,148,44.0,1.6,Former,0
P-1040,65,Female,Non-Anginal,160,360,0,151,38.0,2.1,Smoker,1
P-1041,51,Female,Non-Anginal,140,308,0,142,48.5,1.2,Never,0
P-1042,48,Male,Atypical,130,245,0,180,60.0,1.0,Never,0
P-1043,45,Male,Asymptomatic,104,208,0,148,53.4,1.1,Smoker,0
P-1044,53,Female,Asymptomatic,130,264,0,143,50.1,1.1,Never,0
P-1045,39,Male,Non-Anginal,140,321,0,182,62.5,0.9,Never,0
P-1046,52,Male,Atypical,120,325,0,172,56.0,1.0,Former,0
P-1047,44,Male,Non-Anginal,140,235,0,180,61.0,0.9,Never,0
P-1048,47,Male,Non-Anginal,138,257,0,156,54.0,1.1,Former,0
P-1049,53,Female,Non-Anginal,128,216,0,115,41.2,1.7,Smoker,1
P-1050,53,Female,Asymptomatic,138,234,0,160,52.8,1.0,Never,0
P-1051,51,Female,Non-Anginal,130,256,0,149,53.5,1.0,Never,0
P-1052,66,Male,Asymptomatic,120,302,0,151,37.0,2.3,Smoker,1
P-1053,62,Male,Non-Anginal,130,231,0,146,43.0,1.5,Former,1
P-1054,44,Female,Non-Anginal,108,141,0,175,63.5,0.8,Never,0
P-1055,63,Female,Non-Anginal,135,252,0,172,50.0,1.2,Former,0
P-1056,52,Male,Atypical,134,201,0,158,55.2,1.0,Never,0
P-1057,48,Male,Asymptomatic,122,222,0,186,61.8,0.9,Never,0
P-1058,45,Male,Asymptomatic,115,260,0,185,60.5,1.0,Never,0
P-1059,34,Male,Typical,118,182,0,174,66.0,0.8,Never,0
P-1060,57,Female,Asymptomatic,128,303,0,159,49.0,1.1,Former,0
P-1061,71,Female,Non-Anginal,110,265,1,130,34.5,2.9,Smoker,1
P-1062,54,Male,Atypical,108,309,0,156,51.5,1.1,Former,0
P-1063,52,Male,Typical,118,186,0,190,62.0,0.9,Never,0
P-1064,41,Male,Atypical,135,203,0,132,48.0,1.3,Smoker,0
P-1065,58,Male,Non-Anginal,140,211,1,165,46.5,1.4,Former,1
P-1066,35,Female,Asymptomatic,138,183,0,182,64.5,0.8,Never,0
P-1067,51,Male,Non-Anginal,100,222,0,143,51.0,1.1,Smoker,0
P-1068,45,Female,Atypical,130,234,0,175,59.5,0.9,Never,0
P-1069,44,Male,Atypical,120,220,0,170,60.0,1.0,Never,0
P-1070,62,Female,Asymptomatic,124,209,0,163,47.2,1.3,Former,0
P-1071,54,Male,Non-Anginal,120,258,0,147,48.8,1.2,Smoker,0
P-1072,51,Male,Non-Anginal,94,227,0,154,52.0,1.1,Smoker,0
P-1073,29,Male,Atypical,130,204,0,202,68.0,0.7,Never,0
P-1074,51,Male,Asymptomatic,140,261,0,186,58.0,1.0,Former,0
P-1075,43,Female,Non-Anginal,122,213,0,165,59.0,0.9,Never,0
P-1076,55,Female,Atypical,135,250,0,161,53.2,,Never,0
P-1077,51,Male,Non-Anginal,125,245,1,166,51.8,1.1,Former,0
P-1078,59,Male,Atypical,140,221,0,164,49.5,1.2,Smoker,0
P-1079,52,Male,Atypical,128,205,1,184,59.0,0.9,Never,0
P-1080,58,Male,Non-Anginal,105,240,0,154,46.0,1.4,Smoker,1
P-1081,41,Male,Non-Anginal,112,250,0,179,61.2,0.9,Never,0
P-1082,45,Male,Atypical,128,308,0,170,57.5,1.0,Former,0
P-1083,60,Female,Non-Anginal,102,318,0,160,48.0,1.3,Never,0
P-1084,52,Male,Typical,152,298,1,178,44.2,1.6,Smoker,1
P-1085,42,Female,Asymptomatic,102,265,0,122,49.0,1.2,Never,0
P-1086,67,Female,Non-Anginal,115,564,0,160,31.0,4.2,Smoker,1
P-1087,68,Male,Non-Anginal,118,277,0,151,36.0,2.5,Former,1
P-1088,46,Male,Atypical,101,197,1,156,56.5,1.0,Never,0
P-1089,54,Female,Non-Anginal,110,214,0,158,53.0,1.0,Never,0
P-1090,58,Female,Asymptomatic,100,248,0,122,39.0,2.0,Smoker,1
P-1001,63,Male,Asymptomatic,145,233,1,150,38.5,1.9,Smoker,1
P-1009,52,Male,Non-Anginal,172,199,1,162,41.0,1.6,Smoker,1`,
  },
  {
    id: 'saas_churn_telemetry',
    name: 'B2B SaaS Customer Revenue & Churn',
    fileName: 'saas_enterprise_retention.csv',
    domain: 'SaaS Product Analytics',
    description: 'Enterprise subscription accounts tracking MRR, seat utilization, support tickets, API latency, missing NPS scores, and churn outcomes.',
    csvContent: `account_id,plan_tier,tenure_months,monthly_mrr_usd,active_seats,seat_utilization_pct,monthly_api_calls_k,support_tickets_30d,nps_score,contract_type,churned
ACC-201,Enterprise,36,4850,95,91.2,1420,1,68,Annual,0
ACC-202,Growth,14,1250,24,78.5,410,3,45,Monthly,0
ACC-203,Starter,4,320,5,42.0,85,7,12,Monthly,1
ACC-204,Enterprise,42,6200,140,94.8,2150,0,74,Annual,0
ACC-205,Growth,8,980,18,55.0,230,5,28,Monthly,1
ACC-206,Starter,2,290,4,31.5,45,9,-10,Monthly,1
ACC-207,Enterprise,28,3900,72,86.4,1180,2,,Annual,0
ACC-208,Growth,19,1640,32,82.1,590,1,54,Annual,0
ACC-209,Starter,6,410,8,61.0,120,4,35,Monthly,0
ACC-210,Growth,11,1120,21,49.2,195,8,15,Monthly,1
ACC-211,Enterprise,51,8900,210,96.5,3400,1,81,Annual,0
ACC-212,Starter,3,310,6,28.0,38,11,-15,Monthly,1
ACC-213,Growth,22,1890,38,85.0,710,2,61,Annual,0
ACC-214,Enterprise,31,4400,85,89.1,1340,1,,Annual,0
ACC-215,Starter,9,450,9,68.4,155,2,42,Monthly,0
ACC-216,Growth,5,890,15,39.5,110,9,5,Monthly,1
ACC-217,Enterprise,45,7100,165,93.2,2680,1,76,Annual,0
ACC-218,Growth,16,1420,28,74.0,480,3,48,Annual,0
ACC-219,Starter,1,250,3,22.0,20,14,-25,Monthly,1
ACC-220,Enterprise,60,18500,420,98.1,8900,0,88,Annual,0
ACC-221,Growth,12,1180,22,71.5,390,3,,Monthly,0
ACC-222,Starter,7,380,7,58.0,105,4,31,Monthly,0
ACC-223,Growth,4,920,16,44.0,95,8,10,Monthly,1
ACC-224,Enterprise,33,5100,104,90.5,1590,2,65,Annual,0
ACC-225,Starter,11,490,10,73.2,180,1,51,Annual,0
ACC-226,Growth,25,2150,44,88.0,840,1,64,Annual,0
ACC-227,Starter,2,280,4,25.5,32,12,-18,Monthly,1
ACC-228,Enterprise,39,5600,118,92.0,1820,1,71,Annual,0
ACC-229,Growth,9,1050,19,52.4,210,6,22,Monthly,1
ACC-230,Starter,15,520,11,76.0,215,2,49,Annual,0
ACC-201,Enterprise,36,4850,95,91.2,1420,1,68,Annual,0`,
  },
];
