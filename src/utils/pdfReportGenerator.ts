import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { DataFrameState, EDA_STEPS_META } from './edaEngine';
import { PersistedChatMessage } from '../services/sessionStorageService';

function stripMarkdownForPdf(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '') // remove code blocks (rendered separately)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function generateEdaPdfReport(
  dfState: DataFrameState,
  messages: PersistedChatMessage[],
  completedSteps: number[]
): void {
  const { profile } = dfState;
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 14;
  const usableWidth = pageWidth - margin * 2;

  const ensureSpace = (currentY: number, neededHeight: number): number => {
    if (currentY + neededHeight > pageHeight - 18) {
      doc.addPage();
      return 18;
    }
    return currentY;
  };

  // =========================================================================
  // 1. EXECUTIVE COVER & DASHBOARD SUMMARY HEADER
  // =========================================================================
  doc.setFillColor(15, 23, 42); // #0F172A
  doc.rect(0, 0, pageWidth, 40, 'F');
  doc.setFillColor(14, 165, 233); // #0EA5E9 accent bar
  doc.rect(0, 40, pageWidth, 1.8, 'F');

  doc.setTextColor(248, 250, 252);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('EXPLORATORY DATA ANALYSIS (EDA) EXECUTIVE REPORT', margin, 16);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(148, 163, 184);
  doc.text(
    `Dataset: ${profile.fileName}  |  Generated: ${new Date().toLocaleString()}  |  Completed: ${completedSteps.length}/8 Steps`,
    margin,
    24
  );
  doc.text(
    `Final Shape: ${profile.rowCount} rows x ${profile.colCount} columns (Initial: ${profile.originalRowCount} rows x ${profile.originalColCount} cols)`,
    margin,
    31
  );

  let yPos = 50;

  // =========================================================================
  // 2. EXECUTIVE DASHBOARD SUMMARY KPI SCORECARD
  // =========================================================================
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(15, 23, 42);
  doc.text('1. Executive Dashboard Summary Scorecard', margin, yPos);
  yPos += 5;

  const numericCols = profile.columns.filter((c) => c.numeric !== undefined);
  const catColsCount = profile.colCount - numericCols.length;
  const completenessPct = (100 - profile.totalMissingPct).toFixed(2);

  const cardWidth = (usableWidth - 9) / 4;
  const cardHeight = 22;
  const kpiCards = [
    {
      label: 'ACTIVE RECORDS',
      value: `${profile.rowCount}`,
      sub: `Initial: ${profile.originalRowCount} rows`,
    },
    {
      label: 'FEATURE COLUMNS',
      value: `${profile.colCount}`,
      sub: `${numericCols.length} numeric, ${catColsCount} categorical`,
    },
    {
      label: 'DATA COMPLETENESS',
      value: `${completenessPct}%`,
      sub: `Remaining nulls: ${profile.totalMissingCells}`,
    },
    {
      label: 'RESIDUAL ANOMALIES',
      value: `${profile.duplicateRowCount} / ${profile.totalOutliersCount}`,
      sub: `Duplicates / IQR Outliers`,
    },
  ];

  kpiCards.forEach((card, idx) => {
    const x = margin + idx * (cardWidth + 3);
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(203, 213, 225);
    doc.rect(x, yPos, cardWidth, cardHeight, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(card.label, x + 3, yPos + 5.5);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text(card.value, x + 3, yPos + 13);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(71, 85, 105);
    doc.text(card.sub, x + 3, yPos + 18.5);
  });

  yPos += cardHeight + 9;

  // =========================================================================
  // 3. EXECUTED PANDAS PIPELINE AUDIT TRAIL
  // =========================================================================
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text('2. Executed Data Cleaning & Transformation Pipeline Log', margin, yPos);
  yPos += 3;

  autoTable(doc, {
    startY: yPos,
    margin: { left: margin, right: margin },
    head: [['#', 'Executed Pandas Pipeline Operation']],
    body: profile.transformationLog.map((entry, i) => [String(i + 1), entry]),
    theme: 'grid',
    headStyles: { fillColor: [15, 23, 42], textColor: [248, 250, 252], fontSize: 8.5 },
    bodyStyles: { fontSize: 8, textColor: [30, 41, 59] },
    columnStyles: {
      0: { cellWidth: 12, halign: 'center' },
    },
  });

  yPos = (doc as any).lastAutoTable.finalY + 9;

  // =========================================================================
  // 4. DATASET SCHEMA & MISSINGNESS INVENTORY
  // =========================================================================
  yPos = ensureSpace(yPos, 35);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text('3. Dataset Feature Schema & Missing Value Profile', margin, yPos);
  yPos += 3;

  autoTable(doc, {
    startY: yPos,
    margin: { left: margin, right: margin },
    head: [
      [
        'Feature Name',
        'Dtype',
        'Non-Null',
        'Missing',
        'Null %',
        'Unique',
        'Sample Values',
      ],
    ],
    body: profile.columns.map((c) => [
      c.name,
      c.dtype,
      String(c.nonNullCount),
      String(c.missingCount),
      `${c.missingPct.toFixed(1)}%`,
      String(c.uniqueCount),
      c.sampleValues.slice(0, 3).join(', '),
    ]),
    theme: 'striped',
    headStyles: { fillColor: [15, 23, 42], textColor: [248, 250, 252], fontSize: 8 },
    bodyStyles: { fontSize: 7.5, textColor: [30, 41, 59] },
  });

  yPos = (doc as any).lastAutoTable.finalY + 9;

  // =========================================================================
  // 5. UNIVARIATE NUMERIC SUMMARY STATISTICS (df.describe)
  // =========================================================================
  if (numericCols.length > 0) {
    yPos = ensureSpace(yPos, 35);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.text('4. Univariate Statistical Summary — Numeric Features (df.describe)', margin, yPos);
    yPos += 3;

    autoTable(doc, {
      startY: yPos,
      margin: { left: margin, right: margin },
      head: [
        [
          'Feature',
          'Mean',
          'Std',
          'Min',
          '25% (Q1)',
          'Median',
          '75% (Q3)',
          'Max',
          'IQR',
          'Outliers',
          'Skew',
        ],
      ],
      body: numericCols.map((c) => {
        const n = c.numeric!;
        return [
          c.name,
          n.mean.toFixed(2),
          n.std.toFixed(2),
          n.min.toFixed(2),
          n.q25.toFixed(2),
          n.median.toFixed(2),
          n.q75.toFixed(2),
          n.max.toFixed(2),
          n.iqr.toFixed(2),
          `${n.outlierCount} (${n.outlierPct}%)`,
          n.skewness.toFixed(2),
        ];
      }),
      theme: 'grid',
      headStyles: { fillColor: [15, 23, 42], textColor: [248, 250, 252], fontSize: 7.5 },
      bodyStyles: { fontSize: 7, textColor: [30, 41, 59] },
    });

    yPos = (doc as any).lastAutoTable.finalY + 9;
  }

  // =========================================================================
  // 6. CATEGORICAL FEATURE DISTRIBUTIONS
  // =========================================================================
  const categoricalCols = profile.columns.filter(
    (c) => c.topCategories && c.topCategories.length > 0
  );
  if (categoricalCols.length > 0) {
    yPos = ensureSpace(yPos, 30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.text('5. Categorical Feature Frequency Distributions', margin, yPos);
    yPos += 3;

    autoTable(doc, {
      startY: yPos,
      margin: { left: margin, right: margin },
      head: [['Categorical Feature', 'Unique Levels', 'Top Category Frequencies']],
      body: categoricalCols.map((c) => [
        c.name,
        String(c.uniqueCount),
        (c.topCategories || [])
          .slice(0, 4)
          .map((cat) => `${cat.value}: ${cat.count} (${cat.pct}%)`)
          .join('  |  '),
      ]),
      theme: 'striped',
      headStyles: { fillColor: [15, 23, 42], textColor: [248, 250, 252], fontSize: 8 },
      bodyStyles: { fontSize: 7.5, textColor: [30, 41, 59] },
    });

    yPos = (doc as any).lastAutoTable.finalY + 9;
  }

  // =========================================================================
  // 7. BIVARIATE PEARSON CORRELATION MATRIX INSIGHTS
  // =========================================================================
  if (profile.correlationMatrix.topPairs.length > 0) {
    yPos = ensureSpace(yPos, 35);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.text('6. Bivariate Correlation Analysis (Strongest Pearson r Pairs)', margin, yPos);
    yPos += 3;

    autoTable(doc, {
      startY: yPos,
      margin: { left: margin, right: margin },
      head: [['Feature A', 'Feature B', 'Pearson r', 'Strength & Direction']],
      body: profile.correlationMatrix.topPairs.slice(0, 10).map((pair) => {
        const abs = Math.abs(pair.r);
        const dir = pair.r >= 0 ? 'Positive' : 'Negative';
        const strength =
          abs >= 0.7 ? 'Strong' : abs >= 0.4 ? 'Moderate' : abs >= 0.2 ? 'Weak' : 'Negligible';
        return [
          pair.colA,
          pair.colB,
          `${pair.r >= 0 ? '+' : ''}${pair.r.toFixed(4)}`,
          `${strength} ${dir} Association`,
        ];
      }),
      theme: 'grid',
      headStyles: { fillColor: [15, 23, 42], textColor: [248, 250, 252], fontSize: 8 },
      bodyStyles: { fontSize: 7.5, textColor: [30, 41, 59] },
    });

    yPos = (doc as any).lastAutoTable.finalY + 9;
  }

  // =========================================================================
  // 8. STEP-BY-STEP SEQUENTIAL EDA FINDINGS, CODE & SANDBOX PLOTS
  // =========================================================================
  // Deduplicate by stepNumber (keep the latest message for each step 1..8)
  const latestStepMessagesMap = new Map<number, PersistedChatMessage>();
  messages.forEach((m) => {
    if (m.role === 'assistant' && m.stepNumber && m.stepNumber >= 1 && m.stepNumber <= 8) {
      latestStepMessagesMap.set(m.stepNumber, m);
    }
  });

  const orderedStepNums = Array.from(latestStepMessagesMap.keys()).sort((a, b) => a - b);

  if (orderedStepNums.length > 0) {
    yPos = ensureSpace(yPos, 25);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text('7. Sequential 8-Step EDA Protocol Findings & Python Code', margin, yPos);
    yPos += 6;

    for (const stepNum of orderedStepNums) {
      const msg = latestStepMessagesMap.get(stepNum)!;
      const meta = EDA_STEPS_META[stepNum - 1];

      yPos = ensureSpace(yPos, 30);

      // Step Header Bar
      doc.setFillColor(241, 245, 249);
      doc.setDrawColor(203, 213, 225);
      doc.rect(margin, yPos, usableWidth, 8, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(15, 23, 42);
      doc.text(`Step 0${stepNum}: ${meta?.title || ''}`, margin + 3, yPos + 5.5);
      yPos += 11;

      // Executed Python Code Snippet
      if (msg.pythonCode) {
        const codeLines = doc.splitTextToSize(msg.pythonCode.trim(), usableWidth - 6);
        const codeBlockHeight = Math.min(codeLines.length * 3.8 + 5, 55);
        yPos = ensureSpace(yPos, codeBlockHeight + 4);

        doc.setFillColor(15, 23, 42);
        doc.rect(margin, yPos, usableWidth, codeBlockHeight, 'F');
        doc.setFont('courier', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(226, 232, 240);
        doc.text(codeLines.slice(0, 13), margin + 3, yPos + 4.5);
        yPos += codeBlockHeight + 4;
      }

      // Narrative Markdown Text
      const cleanNarrative = stripMarkdownForPdf(msg.content);
      if (cleanNarrative) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(30, 41, 59);
        const textLines: string[] = doc.splitTextToSize(cleanNarrative, usableWidth);

        for (const line of textLines) {
          yPos = ensureSpace(yPos, 5);
          doc.text(line, margin, yPos);
          yPos += 4.3;
        }
        yPos += 3;
      }

      // Embedded Python Sandbox Matplotlib Plots (if present)
      if (msg.sandboxPlots && msg.sandboxPlots.length > 0) {
        for (const plot of msg.sandboxPlots) {
          try {
            const imgDataUrl = `data:${plot.mimeType || 'image/png'};base64,${plot.data}`;
            const imgHeight = 62;
            const imgWidth = Math.min(usableWidth, 125);
            yPos = ensureSpace(yPos, imgHeight + 6);
            doc.addImage(imgDataUrl, 'PNG', margin, yPos, imgWidth, imgHeight);
            yPos += imgHeight + 5;
          } catch {
            // Skip invalid plot image encoding
          }
        }
      }

      yPos += 4;
    }
  }

  // =========================================================================
  // 9. PAGE FOOTERS across all pages
  // =========================================================================
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(226, 232, 240);
    doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(
      `Veritas EDA Studio · Exploratory Data Analysis Report · ${profile.fileName}`,
      margin,
      pageHeight - 7.5
    );
    doc.text(`Page ${p} of ${totalPages}`, pageWidth - margin, pageHeight - 7.5, {
      align: 'right',
    });
  }

  const safeBaseName = profile.fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  doc.save(`eda_report_${safeBaseName}.pdf`);
}
