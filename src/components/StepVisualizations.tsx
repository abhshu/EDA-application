import React, { useState } from 'react';
import { DataFrameProfile, PandasDType } from '../utils/edaEngine';

interface StepVisualizationsProps {
  step: number;
  profile: DataFrameProfile;
  sandboxPlots?: { mimeType: string; data: string }[];
  onApplyMissingFix?: (strategy: 'impute_median_mode' | 'drop_rows' | 'drop_high_missing_cols') => void;
  onApplyOutlierFix?: (mode: 'deduplicate_only' | 'clip_iqr_and_dedup' | 'remove_iqr_and_dedup') => void;
  onApplyTransform?: (mode: 'log_skewed' | 'label_encode_cats' | 'standardize_numeric') => void;
  onChangeColumnDType?: (colName: string, newDType: PandasDType) => void;
  onExportCSV?: () => void;
  onExportReport?: () => void;
  onExportPDF?: () => void;
  onOpenDashboardTab?: () => void;
}

function getCorrelationColor(r: number): { bg: string; text: string } {
  const clamped = Math.max(-1, Math.min(1, r));
  const abs = Math.abs(clamped);
  const text = abs > 0.35 ? '#F8FAFC' : '#CBD5E1';
  if (clamped >= 0) {
    const alpha = Math.round(abs * 0.85 * 100) / 100;
    return {
      bg: `rgba(56, 189, 248, ${Math.max(0.08, alpha * 0.75)})`,
      text,
    };
  } else {
    const alpha = Math.round(abs * 0.85 * 100) / 100;
    return {
      bg: `rgba(244, 63, 94, ${Math.max(0.08, alpha * 0.75)})`,
      text,
    };
  }
}

export const StepVisualizations: React.FC<StepVisualizationsProps> = ({
  step,
  profile,
  sandboxPlots = [],
  onApplyMissingFix,
  onApplyOutlierFix,
  onApplyTransform,
  onChangeColumnDType,
  onExportCSV,
  onExportReport,
  onExportPDF,
  onOpenDashboardTab,
}) => {
  const numericCols = profile.columns.filter((c) => c.numeric !== undefined);
  const datetimeCols = profile.columns.filter((c) => c.dtype === 'datetime64[ns]');
  const categoricalCols = profile.columns.filter((c) => c.topCategories && c.topCategories.length > 0);
  const [selectedUniCol, setSelectedUniCol] = useState<string>(numericCols[0]?.name || '');
  const [selectedScatterIdx, setSelectedScatterIdx] = useState<number>(0);

  return (
    <div className="mt-5 space-y-6">
      {/* If Gemini's built-in Python codeExecution sandbox returned inline PNG plots, render them first */}
      {sandboxPlots.length > 0 && (
        <div className="border border-slate-800 bg-slate-900/90 p-4">
          <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-2 text-xs text-slate-400">
            <span className="font-semibold text-slate-200">Python Sandbox Matplotlib Output</span>
            <span className="font-mono">plt.show() · inline figure</span>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {sandboxPlots.map((img, i) => (
              <div key={i} className="overflow-hidden border border-slate-800 bg-slate-950 p-2">
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={`Python Matplotlib figure ${i + 1} for Step ${step}`}
                  referrerPolicy="no-referrer"
                  className="mx-auto max-h-80 w-auto object-contain"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* STEP 1: Feature Taxonomy & Problem Scope Table */}
      {step === 1 && (
        <div className="border border-slate-800 bg-slate-900/80">
          <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/60 px-4 py-2.5">
            <span className="text-xs font-semibold text-slate-200">
              Step 1 · Dataset Variable Taxonomy & Grain Overview
            </span>
            <span className="font-mono text-xs text-slate-400 tabular-nums">
              {profile.rowCount} rows × {profile.colCount} columns
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/40 text-slate-400">
                  <th className="px-4 py-2.5 font-semibold">Feature Name</th>
                  <th className="px-4 py-2.5 font-semibold">Detected Dtype</th>
                  <th className="px-4 py-2.5 font-semibold">Analytical Role</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Unique Values</th>
                  <th className="px-4 py-2.5 font-semibold">Sample Values</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {profile.columns.map((col, idx) => {
                  const isId =
                    col.dtype !== 'datetime64[ns]' &&
                    col.uniqueCount === profile.rowCount &&
                    (col.name.toLowerCase().includes('id') || idx === 0);
                  const isTarget =
                    col.dtype !== 'datetime64[ns]' &&
                    idx === profile.columns.length - 1 &&
                    col.uniqueCount <= 10;
                  const role =
                    col.dtype === 'datetime64[ns]'
                      ? 'Temporal / Datetime Variable'
                      : isId
                      ? 'Identifier / Primary Key'
                      : isTarget
                      ? 'Candidate Target Variable'
                      : col.numeric
                      ? 'Continuous / Quantitative Predictor'
                      : 'Categorical / Factor Predictor';
                  return (
                    <tr key={col.name} className="hover:bg-slate-800/40">
                      <td className="px-4 py-2 font-mono font-medium text-slate-100">{col.name}</td>
                      <td className="px-4 py-2 font-mono text-sky-400">
                        {onChangeColumnDType ? (
                          <select
                            value={col.dtype}
                            onChange={(e) =>
                              onChangeColumnDType(col.name, e.target.value as PandasDType)
                            }
                            title="Click to revise variable data type"
                            className="border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-sky-400 focus:border-sky-500 focus:outline-none"
                          >
                            <option value="datetime64[ns]">datetime64[ns]</option>
                            <option value="int64">int64</option>
                            <option value="float64">float64</option>
                            <option value="object">object</option>
                            <option value="bool">bool</option>
                          </select>
                        ) : (
                          col.dtype
                        )}
                      </td>
                      <td
                        className={`px-4 py-2 ${
                          col.dtype === 'datetime64[ns]'
                            ? 'font-medium text-emerald-400'
                            : 'text-slate-300'
                        }`}
                      >
                        {role}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-slate-300 tabular-nums">
                        {col.uniqueCount}
                      </td>
                      <td className="max-w-xs truncate px-4 py-2 font-mono text-slate-400">
                        {col.sampleValues.slice(0, 3).join(', ')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* STEP 2: df.head(), df.info(), and Dtype Distribution Plot */}
      {step === 2 && (
        <div className="space-y-5">
          {/* df.head(5) Table */}
          <div className="border border-slate-800 bg-slate-900/80">
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/60 px-4 py-2.5">
              <span className="text-xs font-semibold text-slate-200">
                DataFrame Preview · <code className="font-mono text-sky-400">df.head(5)</code>
              </span>
              <span className="font-mono text-xs text-slate-400 tabular-nums">
                Shape: ({profile.rowCount}, {profile.colCount}) · {(profile.memoryBytes / 1024).toFixed(1)} KB
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/40 text-slate-400">
                    <th className="px-3 py-2 font-mono font-semibold text-slate-500">#</th>
                    {profile.columns.map((c) => (
                      <th key={c.name} className="px-3 py-2 font-mono font-semibold whitespace-nowrap text-slate-200">
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80 font-mono">
                  {profile.headRows.slice(0, 5).map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-slate-800/40">
                      <td className="px-3 py-2 text-slate-500 tabular-nums">{rIdx}</td>
                      {profile.columns.map((c) => {
                        const val = row[c.name];
                        const isNull = val === null || val === undefined || val === '';
                        return (
                          <td
                            key={c.name}
                            className={`px-3 py-2 whitespace-nowrap tabular-nums ${
                              isNull ? 'italic text-amber-400' : 'text-slate-200'
                            }`}
                          >
                            {isNull ? 'NaN' : String(val)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Matplotlib-style Non-Null Completeness & Dtype Plot */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="border border-slate-800 bg-slate-900/80 p-4">
              <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-2">
                <span className="text-xs font-semibold text-slate-200">
                  Matplotlib Figure 2.1 · Non-Null Count by Feature (<code className="font-mono text-sky-400">df.info()</code>)
                </span>
                <span className="font-mono text-xs text-slate-400">sns.barplot()</span>
              </div>
              <div className="space-y-2.5">
                {profile.columns.slice(0, 10).map((col) => {
                  const pct = profile.rowCount > 0 ? (col.nonNullCount / profile.rowCount) * 100 : 100;
                  return (
                    <div key={col.name} className="grid grid-cols-12 items-center gap-2 text-xs">
                      <div className="col-span-4 truncate font-mono text-slate-300" title={col.name}>
                        {col.name}
                      </div>
                      <div className="col-span-5 h-3.5 w-full bg-slate-800">
                        <div
                          className="h-full bg-sky-500 transition-all"
                          style={{ width: `${Math.max(2, pct)}%` }}
                        />
                      </div>
                      <div className="col-span-3 text-right font-mono text-slate-400 tabular-nums">
                        {col.nonNullCount}/{profile.rowCount} · {col.dtype}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="border border-slate-800 bg-slate-900/80 p-4">
              <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-2">
                <span className="text-xs font-semibold text-slate-200">
                  Matplotlib Figure 2.2 · Data Type Composition (<code className="font-mono text-sky-400">df.dtypes.value_counts()</code>)
                </span>
                <span className="font-mono text-xs text-slate-400">tabular-nums</span>
              </div>
              {(() => {
                const counts: Record<string, number> = {};
                profile.columns.forEach((c) => {
                  counts[c.dtype] = (counts[c.dtype] || 0) + 1;
                });
                const entries = Object.entries(counts);
                return (
                  <div className="space-y-3 pt-2">
                    {entries.map(([dtype, cnt]) => {
                      const pct = ((cnt / profile.colCount) * 100).toFixed(1);
                      return (
                        <div key={dtype} className="space-y-1">
                          <div className="flex justify-between font-mono text-xs">
                            <span className="font-semibold text-slate-200">{dtype}</span>
                            <span className="text-slate-400 tabular-nums">
                              {cnt} cols ({pct}%)
                            </span>
                          </div>
                          <div className="h-5 w-full bg-slate-800">
                            <div
                              className="h-full bg-indigo-500"
                              style={{ width: `${(cnt / profile.colCount) * 100}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* STEP 3: Missing Values Table, Plot & Interactive Pandas Imputation Actions */}
      {step === 3 && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Missingness Bar Chart */}
            <div className="border border-slate-800 bg-slate-900/80 p-4">
              <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-2">
                <span className="text-xs font-semibold text-slate-200">
                  Seaborn Figure 3.1 · Missing Value Percentage (<code className="font-mono text-sky-400">df.isnull().mean() * 100</code>)
                </span>
                <span className="font-mono text-xs text-slate-400 tabular-nums">
                  Total Nulls: {profile.totalMissingCells} ({profile.totalMissingPct}%)
                </span>
              </div>
              <div className="space-y-2.5">
                {[...profile.columns]
                  .sort((a, b) => b.missingPct - a.missingPct)
                  .slice(0, 10)
                  .map((col) => (
                    <div key={col.name} className="grid grid-cols-12 items-center gap-2 text-xs">
                      <div className="col-span-4 truncate font-mono text-slate-200" title={col.name}>
                        {col.name}
                      </div>
                      <div className="col-span-5 h-4 w-full bg-slate-800">
                        <div
                          className={`h-full transition-all ${
                            col.missingPct > 20
                              ? 'bg-rose-500'
                              : col.missingPct > 0
                              ? 'bg-amber-500'
                              : 'bg-emerald-500'
                          }`}
                          style={{ width: `${col.missingPct > 0 ? Math.max(4, col.missingPct) : 2}%` }}
                        />
                      </div>
                      <div className="col-span-3 text-right font-mono text-slate-300 tabular-nums">
                        {col.missingCount} ({col.missingPct.toFixed(1)}%)
                      </div>
                    </div>
                  ))}
              </div>
            </div>

            {/* Missingness Matrix & Recommended Fix Table */}
            <div className="border border-slate-800 bg-slate-900/80 p-4">
              <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-2">
                <span className="text-xs font-semibold text-slate-200">
                  Column Imputation Strategy Recommendations
                </span>
                <span className="font-mono text-xs text-slate-400">Pandas Action Plan</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400">
                      <th className="py-2 font-semibold">Feature</th>
                      <th className="py-2 text-right font-semibold">Null %</th>
                      <th className="py-2 pl-4 font-semibold">Recommended Fix</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {profile.columns.map((c) => {
                      const rec =
                        c.missingCount === 0
                          ? 'Complete (No action required)'
                          : c.missingPct > 35
                          ? 'Drop column (df.drop) or missing indicator'
                          : c.numeric
                          ? `Impute median (${c.numeric.median})`
                          : `Impute mode ('${c.mode || 'Unknown'}')`;
                      return (
                        <tr key={c.name}>
                          <td className="py-1.5 font-mono font-medium text-slate-100">{c.name}</td>
                          <td className="py-1.5 text-right font-mono text-slate-300 tabular-nums">
                            {c.missingPct.toFixed(2)}%
                          </td>
                          <td className="py-1.5 pl-4 text-slate-400">{rec}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Interactive DataFrame Imputation Controls */}
          {onApplyMissingFix && profile.totalMissingCells > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border border-sky-900/80 bg-sky-950/30 px-4 py-3">
              <div className="text-xs text-slate-300">
                <span className="font-semibold text-slate-100">Execute Live Pandas Missing Value Fix: </span>
                Apply an imputation strategy directly to the in-memory DataFrame before moving to Step 4.
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onApplyMissingFix('impute_median_mode')}
                  className="bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 whitespace-nowrap"
                >
                  Impute Median / Mode (Recommended)
                </button>
                <button
                  type="button"
                  onClick={() => onApplyMissingFix('drop_rows')}
                  className="border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
                >
                  Drop Null Rows (df.dropna)
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* STEP 4: Duplicates & IQR Outliers Table + Actions */}
      {step === 4 && (
        <div className="space-y-4">
          <div className="border border-slate-800 bg-slate-900/80">
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/60 px-4 py-2.5">
              <span className="text-xs font-semibold text-slate-200">
                Step 4 · Interquartile Range (IQR) Outlier Detection & Duplicate Row Audit
              </span>
              <span className="font-mono text-xs text-slate-400 tabular-nums">
                Duplicates: {profile.duplicateRowCount} rows · Total IQR Outliers: {profile.totalOutliersCount}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/40 text-slate-400">
                    <th className="px-4 py-2.5 font-semibold">Numeric Feature</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Q1 (25%)</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Median (50%)</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Q3 (75%)</th>
                    <th className="px-4 py-2.5 text-right font-semibold">IQR</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Lower Fence</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Upper Fence</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Outliers</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80 font-mono">
                  {numericCols.map((c) => {
                    const st = c.numeric!;
                    return (
                      <tr key={c.name} className="hover:bg-slate-800/40">
                        <td className="px-4 py-2 font-medium text-slate-100">{c.name}</td>
                        <td className="px-4 py-2 text-right text-slate-300 tabular-nums">{st.q25}</td>
                        <td className="px-4 py-2 text-right text-slate-300 tabular-nums">{st.median}</td>
                        <td className="px-4 py-2 text-right text-slate-300 tabular-nums">{st.q75}</td>
                        <td className="px-4 py-2 text-right text-slate-200 tabular-nums">{st.iqr}</td>
                        <td className="px-4 py-2 text-right text-slate-400 tabular-nums">{st.lowerBound}</td>
                        <td className="px-4 py-2 text-right text-slate-400 tabular-nums">{st.upperBound}</td>
                        <td
                          className={`px-4 py-2 text-right font-semibold tabular-nums ${
                            st.outlierCount > 0 ? 'text-amber-400' : 'text-emerald-400'
                          }`}
                        >
                          {st.outlierCount} ({st.outlierPct}%)
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {onApplyOutlierFix && (profile.duplicateRowCount > 0 || profile.totalOutliersCount > 0) && (
            <div className="flex flex-wrap items-center justify-between gap-3 border border-sky-900/80 bg-sky-950/30 px-4 py-3">
              <div className="text-xs text-slate-300">
                <span className="font-semibold text-slate-100">Execute Live Pandas Anomaly Remediation: </span>
                Remove exact duplicates ({profile.duplicateRowCount}) and cap or filter IQR outliers ({profile.totalOutliersCount}).
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onApplyOutlierFix('clip_iqr_and_dedup')}
                  className="bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 whitespace-nowrap"
                >
                  Deduplicate & Winsorize/Clip IQR Outliers
                </button>
                <button
                  type="button"
                  onClick={() => onApplyOutlierFix('remove_iqr_and_dedup')}
                  className="border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
                >
                  Deduplicate & Filter Out Outlier Rows
                </button>
                {profile.duplicateRowCount > 0 && (
                  <button
                    type="button"
                    onClick={() => onApplyOutlierFix('deduplicate_only')}
                    className="border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
                  >
                    Drop Duplicates Only
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* STEP 5: Data Transformation & Feature Engineering Table + Controls */}
      {step === 5 && (
        <div className="space-y-4">
          <div className="border border-slate-800 bg-slate-900/80">
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/60 px-4 py-2.5">
              <span className="text-xs font-semibold text-slate-200">
                Step 5 · Feature Skewness, Scaling & Categorical Encoding Audit
              </span>
              <span className="font-mono text-xs text-slate-400">df.dtypes · df.skew()</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/40 text-slate-400">
                    <th className="px-4 py-2.5 font-semibold">Column</th>
                    <th className="px-4 py-2.5 font-semibold">Current Dtype</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Cardinality</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Skewness</th>
                    <th className="px-4 py-2.5 font-semibold">Recommended Transformation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {profile.columns.map((c) => {
                    const skew = c.numeric?.skewness;
                    let suggestion = 'Retain as-is (well-behaved distribution)';
                    if (c.dtype === 'datetime64[ns]') {
                      suggestion =
                        'Temporal / Datetime index (pd.to_datetime; extract period features if needed)';
                    } else if (c.numeric) {
                      if (Math.abs(c.numeric.skewness) > 0.75 && c.numeric.min >= 0) {
                        suggestion = 'Apply np.log1p() transform to reduce skewness';
                      } else if (c.numeric.std > 50) {
                        suggestion = 'StandardScaler Z-score normalization (μ=0, σ=1)';
                      }
                    } else if (c.dtype === 'object' || c.dtype === 'bool') {
                      if (c.uniqueCount <= 12) {
                        suggestion = `Label / One-Hot Encode (${c.uniqueCount} classes)`;
                      } else {
                        suggestion = 'High-cardinality identifier / text (exclude from encoding)';
                      }
                    }
                    return (
                      <tr key={c.name} className="hover:bg-slate-800/40">
                        <td className="px-4 py-2 font-mono font-medium text-slate-100">{c.name}</td>
                        <td className="px-4 py-2 font-mono text-sky-400">
                          {onChangeColumnDType ? (
                            <select
                              value={c.dtype}
                              onChange={(e) =>
                                onChangeColumnDType(c.name, e.target.value as PandasDType)
                              }
                              title="Click to revise variable data type"
                              className="border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-sky-400 focus:border-sky-500 focus:outline-none"
                            >
                              <option value="datetime64[ns]">datetime64[ns]</option>
                              <option value="int64">int64</option>
                              <option value="float64">float64</option>
                              <option value="object">object</option>
                              <option value="bool">bool</option>
                            </select>
                          ) : (
                            c.dtype
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-slate-300 tabular-nums">
                          {c.uniqueCount}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-slate-300 tabular-nums">
                          {skew !== undefined ? skew.toFixed(3) : '—'}
                        </td>
                        <td className="px-4 py-2 text-slate-300">{suggestion}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {onApplyTransform && (
            <div className="flex flex-wrap items-center justify-between gap-3 border border-sky-900/80 bg-sky-950/30 px-4 py-3">
              <div className="text-xs text-slate-300">
                <span className="font-semibold text-slate-100">Execute Live Pandas Transformation: </span>
                Create transformed/encoded columns in the active DataFrame.
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onApplyTransform('label_encode_cats')}
                  className="bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 whitespace-nowrap"
                >
                  Encode Categorical Features
                </button>
                <button
                  type="button"
                  onClick={() => onApplyTransform('log_skewed')}
                  className="border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
                >
                  Log-Transform Skewed Features (np.log1p)
                </button>
                <button
                  type="button"
                  onClick={() => onApplyTransform('standardize_numeric')}
                  className="border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
                >
                  Standardize Numeric (Z-Score)
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* STEP 6: Univariate Analysis (df.describe(), Histograms + KDE, IQR Boxplots) */}
      {step === 6 && (
        <div className="space-y-5">
          {/* df.describe() Markdown-style Table */}
          <div className="border border-slate-800 bg-slate-900/80">
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/60 px-4 py-2.5">
              <span className="text-xs font-semibold text-slate-200">
                Step 6 · Univariate Summary Statistics (<code className="font-mono text-sky-400">df.describe().T</code>)
              </span>
              <span className="font-mono text-xs text-slate-400">tabular-nums</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/40 text-slate-400">
                    <th className="px-3 py-2 font-semibold">Feature</th>
                    <th className="px-3 py-2 text-right font-semibold">count</th>
                    <th className="px-3 py-2 text-right font-semibold">mean</th>
                    <th className="px-3 py-2 text-right font-semibold">std</th>
                    <th className="px-3 py-2 text-right font-semibold">min</th>
                    <th className="px-3 py-2 text-right font-semibold">25%</th>
                    <th className="px-3 py-2 text-right font-semibold">50%</th>
                    <th className="px-3 py-2 text-right font-semibold">75%</th>
                    <th className="px-3 py-2 text-right font-semibold">max</th>
                    <th className="px-3 py-2 text-right font-semibold">skew</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80 font-mono">
                  {numericCols.map((c) => {
                    const s = c.numeric!;
                    return (
                      <tr key={c.name} className="hover:bg-slate-800/40">
                        <td className="px-3 py-2 font-medium text-slate-100">{c.name}</td>
                        <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{s.count}</td>
                        <td className="px-3 py-2 text-right text-slate-200 tabular-nums">{s.mean.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{s.std.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{s.min.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right text-slate-300 tabular-nums">{s.q25.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right font-semibold text-sky-400 tabular-nums">
                          {s.median.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-300 tabular-nums">{s.q75.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{s.max.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right text-slate-300 tabular-nums">{s.skewness.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Interactive Matplotlib/Seaborn Histograms + Boxplots */}
          {numericCols.length > 0 && (
            <div className="border border-slate-800 bg-slate-900/80 p-4">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                <div>
                  <span className="text-xs font-semibold text-slate-200">
                    Seaborn Figure 6.1 · Distribution Histogram & Horizontal Boxplot (
                    <code className="font-mono text-sky-400">sns.histplot + sns.boxplot</code>)
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1 bg-slate-950 p-1 border border-slate-800">
                  {numericCols.slice(0, 6).map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => setSelectedUniCol(c.name)}
                      className={`px-2.5 py-1 font-mono text-xs transition-colors whitespace-nowrap ${
                        (selectedUniCol || numericCols[0].name) === c.name
                          ? 'bg-sky-600 font-semibold text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>

              {(() => {
                const activeCol =
                  numericCols.find((c) => c.name === selectedUniCol) || numericCols[0];
                const st = activeCol.numeric!;
                const maxBinCount = Math.max(1, ...st.histogram.map((b) => b.count));
                const range = st.max - st.min || 1;
                const q25Pct = ((st.q25 - st.min) / range) * 100;
                const medPct = ((st.median - st.min) / range) * 100;
                const q75Pct = ((st.q75 - st.min) / range) * 100;
                const lowFencePct = Math.max(0, ((Math.max(st.min, st.lowerBound) - st.min) / range) * 100);
                const highFencePct = Math.min(100, ((Math.min(st.max, st.upperBound) - st.min) / range) * 100);

                return (
                  <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
                    {/* Histogram SVG */}
                    <div className="lg:col-span-7">
                      <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
                        <span className="font-mono font-medium text-slate-200">
                          Histogram of {activeCol.name} ({st.histogram.length} bins)
                        </span>
                        <span className="font-mono tabular-nums">
                          μ = {st.mean.toFixed(2)} · σ = {st.std.toFixed(2)} · skew = {st.skewness}
                        </span>
                      </div>
                      <svg viewBox="0 0 460 190" className="w-full border border-slate-800 bg-slate-950/80">
                        {/* Grid lines */}
                        {[0.25, 0.5, 0.75].map((g, i) => (
                          <line
                            key={i}
                            x1={40}
                            x2={445}
                            y1={20 + g * 135}
                            y2={20 + g * 135}
                            stroke="#1E293B"
                            strokeDasharray="3 3"
                          />
                        ))}
                        {/* Bars */}
                        {st.histogram.map((bin, idx) => {
                          const plotW = 400;
                          const barW = plotW / st.histogram.length - 3;
                          const x = 42 + idx * (plotW / st.histogram.length);
                          const barH = (bin.count / maxBinCount) * 130;
                          const y = 155 - barH;
                          return (
                            <g key={idx}>
                              <rect
                                x={x}
                                y={y}
                                width={Math.max(4, barW)}
                                height={Math.max(1, barH)}
                                fill="#0284C7"
                                fillOpacity={0.85}
                                stroke="#38BDF8"
                                strokeWidth={1}
                              />
                              {bin.count > 0 && (
                                <text
                                  x={x + barW / 2}
                                  y={Math.max(12, y - 4)}
                                  textAnchor="middle"
                                  className="fill-slate-300 font-mono text-[9px]"
                                >
                                  {bin.count}
                                </text>
                              )}
                              {idx % 2 === 0 && (
                                <text
                                  x={x + barW / 2}
                                  y={172}
                                  textAnchor="middle"
                                  className="fill-slate-400 font-mono text-[9px]"
                                >
                                  {bin.label}
                                </text>
                              )}
                            </g>
                          );
                        })}
                        {/* KDE Smooth Polyline */}
                        <polyline
                          fill="none"
                          stroke="#F8FAFC"
                          strokeWidth="2"
                          points={st.histogram
                            .map((bin, idx) => {
                              const plotW = 400;
                              const barW = plotW / st.histogram.length;
                              const cx = 42 + idx * barW + barW / 2;
                              const cy = 155 - (bin.count / maxBinCount) * 125;
                              return `${cx},${cy}`;
                            })
                            .join(' ')}
                        />
                        <line x1={40} x2={445} y1={155} y2={155} stroke="#475569" strokeWidth={1} />
                      </svg>
                    </div>

                    {/* Horizontal IQR Boxplot + Categorical Summary */}
                    <div className="flex flex-col justify-between lg:col-span-5">
                      <div className="border border-slate-800 bg-slate-950/80 p-4">
                        <div className="mb-2 flex items-center justify-between text-xs">
                          <span className="font-mono font-medium text-slate-200">
                            IQR Boxplot · {activeCol.name}
                          </span>
                          <span className="font-mono text-slate-400 tabular-nums">
                            IQR = {st.iqr.toFixed(2)}
                          </span>
                        </div>
                        <svg viewBox="0 0 320 90" className="w-full">
                          {/* Whisker line */}
                          <line
                            x1={20 + (lowFencePct / 100) * 280}
                            x2={20 + (highFencePct / 100) * 280}
                            y1={42}
                            y2={42}
                            stroke="#94A3B8"
                            strokeWidth={2}
                          />
                          {/* Left & Right Whisker caps */}
                          <line
                            x1={20 + (lowFencePct / 100) * 280}
                            x2={20 + (lowFencePct / 100) * 280}
                            y1={28}
                            y2={56}
                            stroke="#94A3B8"
                            strokeWidth={2}
                          />
                          <line
                            x1={20 + (highFencePct / 100) * 280}
                            x2={20 + (highFencePct / 100) * 280}
                            y1={28}
                            y2={56}
                            stroke="#94A3B8"
                            strokeWidth={2}
                          />
                          {/* IQR Box (Q1 to Q3) */}
                          <rect
                            x={20 + (q25Pct / 100) * 280}
                            y={22}
                            width={Math.max(6, ((q75Pct - q25Pct) / 100) * 280)}
                            height={40}
                            fill="#0369A1"
                            fillOpacity={0.55}
                            stroke="#38BDF8"
                            strokeWidth={2}
                          />
                          {/* Median line */}
                          <line
                            x1={20 + (medPct / 100) * 280}
                            x2={20 + (medPct / 100) * 280}
                            y1={20}
                            y2={64}
                            stroke="#F8FAFC"
                            strokeWidth={3}
                          />
                          {/* Labels */}
                          <text x={20} y={80} className="fill-slate-400 font-mono text-[9px]">
                            Min: {st.min}
                          </text>
                          <text x={160} y={80} textAnchor="middle" className="fill-sky-400 font-mono text-[9px]">
                            Median: {st.median}
                          </text>
                          <text x={300} y={80} textAnchor="end" className="fill-slate-400 font-mono text-[9px]">
                            Max: {st.max}
                          </text>
                        </svg>
                      </div>

                      {categoricalCols.length > 0 && (
                        <div className="mt-3 border border-slate-800 bg-slate-950/80 p-3">
                          <div className="mb-2 text-xs font-semibold text-slate-200">
                            Categorical Frequency · <code className="font-mono text-sky-400">{categoricalCols[0].name}</code>
                          </div>
                          <div className="space-y-1.5">
                            {categoricalCols[0].topCategories?.slice(0, 4).map((cat) => (
                              <div key={cat.value} className="grid grid-cols-12 items-center gap-2 text-xs">
                                <span className="col-span-4 truncate font-mono text-slate-300">{cat.value}</span>
                                <div className="col-span-5 h-3 bg-slate-800">
                                  <div
                                    className="h-full bg-indigo-500"
                                    style={{ width: `${Math.max(4, cat.pct)}%` }}
                                  />
                                </div>
                                <span className="col-span-3 text-right font-mono text-slate-400 tabular-nums">
                                  {cat.count} ({cat.pct}%)
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* STEP 7: Bivariate & Multivariate Analysis (Annotated Heatmap + Scatter Regression) */}
      {step === 7 && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          {/* Annotated Seaborn Correlation Heatmap */}
          <div className="border border-slate-800 bg-slate-900/80 p-4 lg:col-span-7">
            <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-2">
              <span className="text-xs font-semibold text-slate-200">
                Seaborn Figure 7.1 · Annotated Pearson Correlation Heatmap (<code className="font-mono text-sky-400">sns.heatmap(df.corr())</code>)
              </span>
              <span className="font-mono text-xs text-slate-400">-1.0 to +1.0</span>
            </div>
            {profile.correlationMatrix.columns.length > 1 ? (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-center font-mono text-[11px]">
                  <thead>
                    <tr>
                      <th className="p-1.5 text-left text-slate-400">Variable</th>
                      {profile.correlationMatrix.columns.slice(0, 8).map((col) => (
                        <th key={col} className="max-w-[72px] truncate p-1.5 text-slate-300" title={col}>
                          {col.slice(0, 8)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {profile.correlationMatrix.columns.slice(0, 8).map((rowCol, rIdx) => (
                      <tr key={rowCol}>
                        <td className="p-1.5 text-left font-medium text-slate-200 whitespace-nowrap" title={rowCol}>
                          {rowCol.slice(0, 14)}
                        </td>
                        {profile.correlationMatrix.columns.slice(0, 8).map((colCol, cIdx) => {
                          const r = profile.correlationMatrix.matrix[rIdx]?.[cIdx] ?? 0;
                          const { bg, text } = getCorrelationColor(r);
                          return (
                            <td
                              key={colCol}
                              style={{ backgroundColor: bg, color: text }}
                              className="border border-slate-900 p-2 font-mono tabular-nums"
                              title={`${rowCol} vs ${colCol}: r = ${r}`}
                            >
                              {r.toFixed(2)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-slate-400">Not enough numerical columns to compute a correlation matrix.</p>
            )}
          </div>

          {/* Bivariate Joint Scatter Plot with OLS Regression Line */}
          <div className="border border-slate-800 bg-slate-900/80 p-4 lg:col-span-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
              <span className="text-xs font-semibold text-slate-200">
                Seaborn Figure 7.2 · Bivariate Scatter (<code className="font-mono text-sky-400">sns.regplot</code>)
              </span>
              {profile.bivariateScatters.length > 1 && (
                <div className="flex items-center gap-1 bg-slate-950 p-0.5 border border-slate-800">
                  {profile.bivariateScatters.map((sc, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setSelectedScatterIdx(idx)}
                      className={`px-2 py-0.5 font-mono text-[10px] ${
                        selectedScatterIdx === idx
                          ? 'bg-sky-600 font-semibold text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Pair {idx + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {profile.bivariateScatters.length > 0 ? (
              (() => {
                const sc = profile.bivariateScatters[selectedScatterIdx] || profile.bivariateScatters[0];
                const xs = sc.points.map((p) => p.x);
                const ys = sc.points.map((p) => p.y);
                const minX = Math.min(...xs);
                const maxX = Math.max(...xs);
                const minY = Math.min(...ys);
                const maxY = Math.max(...ys);
                const rangeX = maxX - minX || 1;
                const rangeY = maxY - minY || 1;

                const toSvgX = (x: number) => 36 + ((x - minX) / rangeX) * 260;
                const toSvgY = (y: number) => 165 - ((y - minY) / rangeY) * 140;

                const yStart = sc.slope * minX + sc.intercept;
                const yEnd = sc.slope * maxX + sc.intercept;

                return (
                  <div>
                    <div className="mb-2 flex items-center justify-between font-mono text-xs text-slate-300">
                      <span>
                        {sc.xCol} vs. {sc.yCol}
                      </span>
                      <span className="font-semibold text-sky-400 tabular-nums">
                        Pearson r = {sc.r >= 0 ? '+' : ''}
                        {sc.r.toFixed(3)}
                      </span>
                    </div>
                    <svg viewBox="0 0 320 195" className="w-full border border-slate-800 bg-slate-950/80">
                      <line x1={36} x2={300} y1={165} y2={165} stroke="#475569" />
                      <line x1={36} x2={36} y1={20} y2={165} stroke="#475569" />
                      {/* OLS Line */}
                      <line
                        x1={toSvgX(minX)}
                        y1={Math.max(20, Math.min(165, toSvgY(yStart)))}
                        x2={toSvgX(maxX)}
                        y2={Math.max(20, Math.min(165, toSvgY(yEnd)))}
                        stroke="#F43F5E"
                        strokeWidth={2}
                        strokeDasharray="4 2"
                      />
                      {/* Scatter points */}
                      {sc.points.map((pt, idx) => (
                        <circle
                          key={idx}
                          cx={toSvgX(pt.x)}
                          cy={toSvgY(pt.y)}
                          r={3.2}
                          fill="#38BDF8"
                          fillOpacity={0.78}
                        />
                      ))}
                      <text x={168} y={185} textAnchor="middle" className="fill-slate-400 font-mono text-[9px]">
                        x: {sc.xCol} [{minX.toFixed(1)} .. {maxX.toFixed(1)}]
                      </text>
                    </svg>
                  </div>
                );
              })()
            ) : (
              <p className="text-xs text-slate-400">No bivariate numeric pairs available.</p>
            )}
          </div>
        </div>
      )}

      {/* STEP 8: Final Consolidated Dashboard Summary */}
      {step === 8 && (
        <div className="space-y-5 border border-slate-800 bg-slate-900/90 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
            <div>
              <h4 className="text-sm font-semibold text-slate-100">
                Step 8 · Consolidated Exploratory Data Analysis Dashboard Summary
              </h4>
              <p className="mt-0.5 text-xs text-slate-400">
                Dataset: <span className="font-mono text-sky-400">{profile.fileName}</span> · Final Shape:{' '}
                <span className="font-mono tabular-nums text-slate-200">
                  {profile.rowCount} rows × {profile.colCount} columns
                </span>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {onExportPDF && (
                <button
                  type="button"
                  onClick={onExportPDF}
                  className="bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 whitespace-nowrap"
                >
                  Download PDF Report (.pdf)
                </button>
              )}
              {onExportCSV && (
                <button
                  type="button"
                  onClick={onExportCSV}
                  className="bg-sky-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-sky-500 whitespace-nowrap"
                >
                  Download Cleaned CSV
                </button>
              )}
              {onExportReport && (
                <button
                  type="button"
                  onClick={onExportReport}
                  className="border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
                >
                  Export Markdown (.md)
                </button>
              )}
              {onOpenDashboardTab && (
                <button
                  type="button"
                  onClick={onOpenDashboardTab}
                  className="border border-sky-700 bg-sky-950/60 px-3.5 py-2 text-xs font-medium text-sky-300 hover:bg-sky-900/60 whitespace-nowrap"
                >
                  Open Full Dashboard Tab
                </button>
              )}
            </div>
          </div>

          {/* 4 Key Audit Metrics */}
          <div className="grid grid-cols-2 gap-4 border-b border-slate-800 pb-4 sm:grid-cols-4">
            <div className="border border-slate-800/90 bg-slate-950/60 p-3">
              <div className="text-xs text-slate-400">Active Records</div>
              <div className="mt-1 font-mono text-xl font-semibold text-slate-100 tabular-nums">
                {profile.rowCount}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-slate-400 tabular-nums">
                Initial: {profile.originalRowCount} rows
              </div>
            </div>
            <div className="border border-slate-800/90 bg-slate-950/60 p-3">
              <div className="text-xs text-slate-400">Feature Columns</div>
              <div className="mt-1 font-mono text-xl font-semibold text-slate-100 tabular-nums">
                {profile.colCount}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-slate-400 tabular-nums">
                {numericCols.length} numeric
                {datetimeCols.length > 0 ? ` · ${datetimeCols.length} datetime` : ''} ·{' '}
                {profile.colCount - numericCols.length - datetimeCols.length} categorical
              </div>
            </div>
            <div className="border border-slate-800/90 bg-slate-950/60 p-3">
              <div className="text-xs text-slate-400">Data Completeness</div>
              <div className="mt-1 font-mono text-xl font-semibold text-emerald-400 tabular-nums">
                {(100 - profile.totalMissingPct).toFixed(2)}%
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-slate-400 tabular-nums">
                Remaining nulls: {profile.totalMissingCells}
              </div>
            </div>
            <div className="border border-slate-800/90 bg-slate-950/60 p-3">
              <div className="text-xs text-slate-400">Residual Anomalies</div>
              <div className="mt-1 font-mono text-xl font-semibold text-slate-100 tabular-nums">
                {profile.duplicateRowCount} dups / {profile.totalOutliersCount} IQR
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-slate-400 tabular-nums">
                {profile.transformationLog.length} pipeline operations
              </div>
            </div>
          </div>

          {/* Numeric Feature Summary Snapshot in Dashboard */}
          {numericCols.length > 0 && (
            <div className="border-b border-slate-800 pb-4">
              <div className="mb-2.5 text-xs font-semibold text-slate-200">
                Key Quantitative Feature Summary (Mean · Median · IQR · Skewness)
              </div>
              <div className="overflow-x-auto border border-slate-800 bg-slate-950/50">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-950 text-slate-400">
                      <th className="px-3 py-2 font-semibold">Feature</th>
                      <th className="px-3 py-2 text-right font-semibold">Mean</th>
                      <th className="px-3 py-2 text-right font-semibold">Std Dev</th>
                      <th className="px-3 py-2 text-right font-semibold">Median</th>
                      <th className="px-3 py-2 text-right font-semibold">IQR</th>
                      <th className="px-3 py-2 text-right font-semibold">Skewness</th>
                      <th className="px-3 py-2 text-right font-semibold">Outliers</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80 font-mono tabular-nums">
                    {numericCols.slice(0, 6).map((c) => {
                      const n = c.numeric!;
                      return (
                        <tr key={c.name} className="hover:bg-slate-800/40">
                          <td className="px-3 py-1.5 font-medium text-slate-100">{c.name}</td>
                          <td className="px-3 py-1.5 text-right text-slate-300">{n.mean.toFixed(2)}</td>
                          <td className="px-3 py-1.5 text-right text-slate-400">{n.std.toFixed(2)}</td>
                          <td className="px-3 py-1.5 text-right text-sky-400">{n.median.toFixed(2)}</td>
                          <td className="px-3 py-1.5 text-right text-slate-300">{n.iqr.toFixed(2)}</td>
                          <td className="px-3 py-1.5 text-right text-slate-300">{n.skewness.toFixed(2)}</td>
                          <td className="px-3 py-1.5 text-right text-amber-400">
                            {n.outlierCount} ({n.outlierPct}%)
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Pipeline Transformation Log & Top Correlations */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-semibold text-slate-200">
                Strongest Bivariate Relationships (Pearson |r|)
              </div>
              <div className="space-y-2">
                {profile.correlationMatrix.topPairs.slice(0, 5).map((pair, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between border-b border-slate-800/80 py-1.5 text-xs"
                  >
                    <span className="font-mono text-slate-200">
                      {pair.colA} ↔ {pair.colB}
                    </span>
                    <span className="font-mono font-semibold text-sky-400 tabular-nums">
                      r = {pair.r >= 0 ? '+' : ''}
                      {pair.r.toFixed(4)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold text-slate-200">
                Executed Pandas Pipeline Audit Trail
              </div>
              <ul className="space-y-1.5 font-mono text-xs text-slate-300">
                {profile.transformationLog.map((entry, idx) => (
                  <li key={idx} className="border-l-2 border-sky-500 pl-2.5 py-0.5">
                    {entry}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
