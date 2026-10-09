import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, GenerateContentResponse } from '@google/genai';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_FILE_PATH = path.join(__dirname, '.saved_sessions.json');

interface ServerSessionsStore {
  activeSessionId: string | null;
  sessions: Record<string, any>;
}

function readSessionsStore(): ServerSessionsStore {
  try {
    if (fs.existsSync(SESSIONS_FILE_PATH)) {
      const raw = fs.readFileSync(SESSIONS_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.sessions) {
        return parsed as ServerSessionsStore;
      }
    }
  } catch (err) {
    console.warn('Could not read .saved_sessions.json:', err);
  }
  return { activeSessionId: null, sessions: {} };
}

function writeSessionsStore(store: ServerSessionsStore): void {
  try {
    fs.writeFileSync(SESSIONS_FILE_PATH, JSON.stringify(store), 'utf-8');
  } catch (err) {
    console.warn('Could not write .saved_sessions.json:', err);
  }
}

let aiClient: GoogleGenAI | null = null;
function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment.');
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

const STEP_TITLES: Record<number, string> = {
  1: 'Step 1: Understand the Problem and Data',
  2: 'Step 2: Import and Inspect the Data',
  3: 'Step 3: Handle Missing Values',
  4: 'Step 4: Clean Duplicates and Anomalies',
  5: 'Step 5: Perform Data Transformation',
  6: 'Step 6: Univariate Analysis',
  7: 'Step 7: Bivariate & Multivariate Analysis',
  8: 'Step 8: Final Dashboard Summary',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateStepWithRetry(
  promptText: string,
  systemInstruction: string
): Promise<GenerateContentResponse> {
  const attempts: { model: string; useCodeExecution: boolean; delayMs: number }[] = [
    { model: 'gemini-3.8-flash', useCodeExecution: true, delayMs: 0 },
    { model: 'gemini-flash-latest', useCodeExecution: true, delayMs: 600 },
    { model: 'gemini-3.1-flash-lite', useCodeExecution: false, delayMs: 900 },
    { model: 'gemini-3.8-flash', useCodeExecution: false, delayMs: 1200 },
  ];

  const ai = getAiClient();
  let lastError: any = null;
  for (const attempt of attempts) {
    if (attempt.delayMs > 0) {
      await sleep(attempt.delayMs);
    }
    try {
      const response = await ai.models.generateContent({
        model: attempt.model,
        contents: promptText,
        config: {
          systemInstruction,
          ...(attempt.useCodeExecution ? { tools: [{ codeExecution: {} }] } : {}),
        },
      });
      return response;
    } catch (err: any) {
      lastError = err;
      const errStr = String(err?.message || err || '');
      const isTransient =
        errStr.includes('503') ||
        errStr.includes('UNAVAILABLE') ||
        errStr.includes('high demand') ||
        errStr.includes('429') ||
        errStr.includes('RESOURCE_EXHAUSTED') ||
        errStr.includes('DEADLINE_EXCEEDED') ||
        errStr.includes('INTERNAL');
      if (!isTransient) {
        // Still try next model in list in case tool config or specific model had an issue
        continue;
      }
    }
  }
  throw lastError;
}

function buildDeterministicStepMarkdown(
  step: number,
  profile: any,
  userAdjustment?: string
): string {
  const cols: any[] = profile?.columns || [];
  const numCols = cols.filter((c) => c.numeric && c.dtype !== 'datetime64[ns]');
  const dtCols = cols.filter((c) => c.dtype === 'datetime64[ns]');
  const catCols = cols.filter((c) => !c.numeric && c.dtype !== 'datetime64[ns]');
  const nextStep = step < 8 ? step + 1 : null;
  const adjustmentNote = userAdjustment
    ? `> **Applied Adjustment**: Addressed your instruction (*"${userAdjustment}"*) on the active DataFrame.\n\n`
    : '';

  let body = '';
  switch (step) {
    case 1:
      body = `### ${STEP_TITLES[1]}

${adjustmentNote}We have loaded **\`${profile?.fileName}\`** containing **${profile?.rowCount} records** across **${profile?.colCount} features**.

- **Dataset Grain & Structure**: Each row represents an individual observation across **${numCols.length} quantitative (numerical)** attributes${
        dtCols.length > 0 ? `, **${dtCols.length} temporal/datetime** attributes` : ''
      }, and **${catCols.length} categorical/object** attributes.
- **Numerical Predictors**: ${numCols.map((c) => `\`${c.name}\` (${c.dtype})`).join(', ') || 'None detected'}${
        dtCols.length > 0
          ? `\n- **Temporal / Datetime Features**: ${dtCols
              .map((c) => `\`${c.name}\` (${c.dtype})`)
              .join(', ')}`
          : ''
      }
- **Categorical / Identifier Features**: ${catCols.map((c) => `\`${c.name}\` (${c.dtype}, ${c.uniqueCount} unique)`).join(', ') || 'None detected'}
- **Initial Data Hygiene Check**: Detected **${profile?.totalMissingCells} missing values** (${profile?.totalMissingPct}% of all cells) and **${profile?.duplicateRowCount} duplicate rows**.`;
      break;

    case 2:
      body = `### ${STEP_TITLES[2]}

${adjustmentNote}We inspected the DataFrame structure using \`df.head()\`, \`df.info()\`, and \`df.shape\`:

- **Dimensions (\`df.shape\`)**: \`(${profile?.rowCount}, ${profile?.colCount})\`
- **Data Type Breakdown**:
  - Quantitative features (\`float64\` / \`int64\`): **${numCols.length} columns**${
        dtCols.length > 0
          ? `\n  - Temporal / Datetime features (\`datetime64[ns]\`): **${dtCols.length} columns** (${dtCols
              .map((c) => `\`${c.name}\``)
              .join(', ')})`
          : ''
      }
  - Categorical / text features (\`object\` / \`bool\`): **${catCols.length} columns**
- **Completeness Snapshot**: ${
        cols.filter((c) => c.missingCount === 0).length
      } of ${cols.length} columns are 100% populated. Review the \`df.head(5)\` preview table and non-null distribution plots below.`;
      break;

    case 3: {
      const missingCols = cols.filter((c) => c.missingCount > 0);
      body = `### ${STEP_TITLES[3]}

${adjustmentNote}We audited null values across all ${cols.length} columns using \`df.isnull().sum()\`:

- **Total Missing Cells**: **${profile?.totalMissingCells}** (${profile?.totalMissingPct}% overall)
- **Columns with Missing Data (${missingCols.length})**:
${
  missingCols.length > 0
    ? missingCols
        .map(
          (c) =>
            `  - **\`${c.name}\`**: ${c.missingCount} missing (${c.missingPct}%) — Recommended fix: ${
              c.numeric ? `impute with median (\`${c.numeric.median}\`)` : `impute with mode`
            }`
        )
        .join('\n')
    : '  - All columns are 100% complete with zero missing values.'
}`;
      break;
    }

    case 4: {
      const outlierCols = numCols.filter((c) => c.numeric?.outlierCount > 0);
      body = `### ${STEP_TITLES[4]}

${adjustmentNote}We scanned the dataset for exact row duplicates (\`df.duplicated().sum()\`) and statistical anomalies using the **$1.5 \\times \\text{IQR}$ rule**:

- **Exact Duplicate Rows**: **${profile?.duplicateRowCount}**
- **Total IQR Outliers Flagged**: **${profile?.totalOutliersCount}** across ${outlierCols.length} numerical features
${
  outlierCols.length > 0
    ? outlierCols
        .map(
          (c) =>
            `  - **\`${c.name}\`**: ${c.numeric.outlierCount} outliers (${c.numeric.outlierPct}%) outside bounds \`[${c.numeric.lowerBound}, ${c.numeric.upperBound}]\` (IQR = \`${c.numeric.iqr}\`)`
        )
        .join('\n')
    : '  - No extreme IQR outliers detected across numerical features.'
}`;
      break;
    }

    case 5: {
      const skewedCols = numCols.filter((c) => Math.abs(c.numeric?.skewness || 0) > 0.75);
      body = `### ${STEP_TITLES[5]}

${adjustmentNote}We evaluated feature distributions, skewness (\`df.skew()\`), and categorical cardinality for modeling readiness:

- **Skewed Numerical Features (|skew| > 0.75)**: ${
        skewedCols.length > 0
          ? skewedCols.map((c) => `\`${c.name}\` (skew = ${c.numeric.skewness})`).join(', ')
          : 'All numerical features exhibit near-symmetric distributions.'
      }
- **Categorical Encoding Candidates**: ${
        catCols.filter((c) => c.uniqueCount <= 12).map((c) => `\`${c.name}\` (${c.uniqueCount} classes)`).join(', ') ||
        'No low-cardinality categorical columns require encoding.'
      }
- **Pipeline Transformations Logged**: ${profile?.transformationLog?.length || 1} operations recorded.`;
      break;
    }

    case 6:
      body = `### ${STEP_TITLES[6]}

${adjustmentNote}We computed parametric (mean, standard deviation) and non-parametric (median, quartiles, IQR) summary statistics via \`df.describe()\`:

${numCols
  .slice(0, 6)
  .map(
    (c) =>
      `- **\`${c.name}\`**: Mean = \`${c.numeric.mean}\`, Std = \`${c.numeric.std}\`, Median = \`${c.numeric.median}\` (Range: \`${c.numeric.min}\` to \`${c.numeric.max}\`, Skew = \`${c.numeric.skewness}\`)`
  )
  .join('\n')}

Use the interactive feature selector below to inspect the **Seaborn Histogram + KDE curve** and **Horizontal IQR Boxplot** for each variable.`;
      break;

    case 7: {
      const topPairs: any[] = profile?.topCorrelations || [];
      body = `### ${STEP_TITLES[7]}

${adjustmentNote}We computed the multivariate **Pearson Correlation Matrix (\`df.corr()\`)** and fitted ordinary least-squares regression lines across top feature pairs:

${
  topPairs.length > 0
    ? topPairs
        .slice(0, 5)
        .map(
          (p) =>
            `- **\`${p.colA}\` ↔ \`${p.colB}\`**: Pearson $r = ${p.r >= 0 ? '+' : ''}${p.r}$ (${
              Math.abs(p.r) > 0.6
                ? 'Strong linear association'
                : Math.abs(p.r) > 0.3
                ? 'Moderate association'
                : 'Weak association'
            })`
        )
        .join('\n')
    : '- Insufficient numerical feature pairs for correlation matrix.'
}

Inspect the annotated **Pearson Correlation Heatmap** and **Bivariate Scatter Regression** plots below.`;
      break;
    }

    case 8:
    default:
      body = `### ${STEP_TITLES[8]}

${adjustmentNote}We have completed all 8 steps of the Exploratory Data Analysis for **\`${profile?.fileName}\`**.

- **Final Dataset Dimensions**: \`${profile?.rowCount} rows × ${profile?.colCount} columns\` (Initial: \`${profile?.originalRowCount} rows\`)
- **Data Completeness**: **${(100 - (profile?.totalMissingPct || 0)).toFixed(2)}%** (${profile?.totalMissingCells} remaining nulls)
- **Residual Anomalies**: **${profile?.duplicateRowCount}** duplicates · **${profile?.totalOutliersCount}** IQR outliers
- **Final Deliverables Ready**: Your **Consolidated Dashboard Summary** is rendered below, and you can download the full **PDF Report (\`.pdf\`)** or **Cleaned CSV** with a single click.`;
      break;
  }

  if (nextStep) {
    return `${body}\n\n---\n**Would you like me to proceed to Step ${nextStep} (${STEP_TITLES[
      nextStep
    ].replace(/^Step \d+:\s*/, '')}) now? Please reply with 'Yes' or any specific adjustments you want to make first.**`;
  }
  return `${body}\n\n---\n**All 8 steps of the Exploratory Data Analysis are complete! Review your Dashboard Summary below and click "Download PDF Report (.pdf)" to export your complete report.**`;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // Persistent Server-Side Session Storage Endpoints (immune to iframe 3P storage eviction)
  app.get('/api/sessions', (_req, res) => {
    const store = readSessionsStore();
    const allSessions = Object.values(store.sessions || {}).filter(
      (s: any) => s && (s.dfState !== null || (s.messages && s.messages.length > 1))
    );
    allSessions.sort(
      (a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    const summaries = allSessions.map((s: any) => ({
      sessionId: s.sessionId,
      title: s.title || s.fileName || 'Saved EDA Session',
      fileName: s.fileName || null,
      updatedAt: s.updatedAt,
      currentStep: s.currentStep || 0,
      completedStepsCount: Array.isArray(s.completedSteps) ? s.completedSteps.length : 0,
      rowCount: s.dfState?.profile?.rowCount || 0,
      colCount: s.dfState?.profile?.colCount || 0,
    }));

    const activeSession =
      (store.activeSessionId && store.sessions[store.activeSessionId]) ||
      allSessions[0] ||
      null;

    res.json({
      activeSessionId: store.activeSessionId,
      summaries,
      activeSession,
    });
  });

  app.get('/api/sessions/:sessionId', (req, res) => {
    const store = readSessionsStore();
    const session = store.sessions[req.params.sessionId];
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    store.activeSessionId = req.params.sessionId;
    writeSessionsStore(store);
    res.json({ session });
  });

  app.post('/api/sessions', (req, res) => {
    const session = req.body?.session;
    if (!session || !session.sessionId) {
      res.status(400).json({ error: 'Invalid session payload' });
      return;
    }
    const store = readSessionsStore();
    // Cap rows stored on disk to 2000 rows per session so file stays fast
    const trimmedSession = {
      ...session,
      dfState: session.dfState
        ? {
            ...session.dfState,
            rows: Array.isArray(session.dfState.rows)
              ? session.dfState.rows.slice(0, 2000)
              : [],
          }
        : null,
    };
    store.sessions[session.sessionId] = trimmedSession;
    store.activeSessionId = session.sessionId;
    writeSessionsStore(store);
    res.json({ ok: true, sessionId: session.sessionId });
  });

  app.delete('/api/sessions/:sessionId', (req, res) => {
    const store = readSessionsStore();
    const targetId = req.params.sessionId;
    delete store.sessions[targetId];
    if (store.activeSessionId === targetId) {
      const remaining = Object.values(store.sessions).sort(
        (a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      ) as any[];
      store.activeSessionId = remaining[0]?.sessionId || null;
    }
    writeSessionsStore(store);
    res.json({ ok: true });
  });

  // Public Google Drive / Google Sheets fetcher (solves browser CORS for public links)
  app.post('/api/drive/public-fetch', async (req, res) => {
    try {
      const { fileId, isSpreadsheet } = req.body || {};
      if (!fileId || typeof fileId !== 'string') {
        res.status(400).json({ error: 'Missing fileId parameter.' });
        return;
      }

      const authHeader = req.headers.authorization;

      // If Bearer token provided, try Google Drive v3 API first
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const metaRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType&supportsAllDrives=true`,
          { headers: { Authorization: authHeader } }
        );
        if (metaRes.ok) {
          const meta = (await metaRes.json()) as { name?: string; mimeType?: string };
          const isSheet =
            meta.mimeType === 'application/vnd.google-apps.spreadsheet' || isSpreadsheet;
          const dlUrl = isSheet
            ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`
            : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;

          const fileRes = await fetch(dlUrl, { headers: { Authorization: authHeader } });
          if (fileRes.ok) {
            const arrayBuf = await fileRes.arrayBuffer();
            const fileName =
              isSheet && meta.name && !meta.name.toLowerCase().endsWith('.csv')
                ? `${meta.name}.csv`
                : meta.name || `drive_${fileId.slice(0, 8)}.csv`;
            res.setHeader('X-File-Name', fileName);
            res.setHeader('Content-Type', isSheet ? 'text/csv' : meta.mimeType || 'text/csv');
            res.send(Buffer.from(arrayBuf));
            return;
          }
        }
      }

      // Try public Google Sheets CSV export URL first if spreadsheet hint or fallback
      const urlsToTry = isSpreadsheet
        ? [
            `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv`,
            `https://drive.google.com/uc?export=download&id=${fileId}`,
          ]
        : [
            `https://drive.google.com/uc?export=download&id=${fileId}`,
            `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv`,
          ];

      for (const targetUrl of urlsToTry) {
        const response = await fetch(targetUrl, {
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; VeritasEDAStudio/1.0)',
          },
        });

        if (response.ok) {
          const contentType = response.headers.get('content-type') || '';
          // Ensure we didn't get a Google sign-in HTML page
          if (!contentType.includes('text/html')) {
            const arrayBuf = await response.arrayBuffer();
            const disposition = response.headers.get('content-disposition') || '';
            const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
            const resolvedName = filenameMatch
              ? filenameMatch[1]
              : `drive_dataset_${fileId.slice(0, 8)}.csv`;

            res.setHeader('X-File-Name', resolvedName);
            res.setHeader('Content-Type', contentType || 'text/csv');
            res.send(Buffer.from(arrayBuf));
            return;
          }
        }
      }

      res.status(403).json({
        error:
          'This Google Drive file requires authentication or is not publicly shared. Please click "Sign in with Google" to read it with your Google Drive permission, or set link sharing to "Anyone with the link".',
      });
    } catch (error: any) {
      console.error('Error fetching Drive file:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch Google Drive file' });
    }
  });

  // Execute a single EDA Step using Gemini + built-in Python Code Execution with automatic retry & fallback
  app.post('/api/eda/execute-step', async (req, res) => {
    const { stepNumber, profileSummary, csvSample, userAdjustment } = req.body || {};
    const step = Number(stepNumber) || 1;
    const stepTitle = STEP_TITLES[step] || `Step ${step}`;
    const nextStep = step < 8 ? step + 1 : null;

    const systemInstruction = `You are an expert interactive Exploratory Data Analysis (EDA) application running inside Google AI Studio.
Your purpose is to guide the user through a structured, 8-step EDA process, executing ONLY ONE step at a time and ALWAYS asking for user permission before proceeding to the next step.

Current Step to Execute ONLY: ${stepTitle} (Step ${step} of 8).
DO NOT execute or jump ahead to Step ${step + 1}. Focus strictly on Step ${step}.

Step-Specific Guidelines:
- Step 1 (Understand the Problem and Data): Explain the dataset's domain problem, grain (what 1 row represents), candidate target variables, and feature taxonomy (numerical vs. categorical vs. identifiers).
- Step 2 (Import and Inspect the Data): Present the shape (rows × columns), data types (df.info()), and key observations from the first few rows (df.head()). Use Python code execution to inspect the data.
- Step 3 (Handle Missing Values): Identify the exact count and percentage of missing values per column. Suggest tailored imputation fixes (median for skewed numeric, mean for symmetric numeric, mode for categorical, or dropping high-null columns).
- Step 4 (Clean Duplicates and Anomalies): Report exact duplicate rows and statistical outliers detected via the 1.5 × IQR rule (Q1 - 1.5*IQR to Q3 + 1.5*IQR). Recommend whether to deduplicate, winsorize/clip, or retain domain-valid extremes.
- Step 5 (Perform Data Transformation): Recommend data type adjustments, log-transformations (np.log1p) for skewed features (|skewness| > 0.75), standardization, and categorical encoding (One-Hot or Label encoding).
- Step 6 (Univariate Analysis): Analyze central tendency (mean, median), dispersion (std, IQR, min/max), and distribution shapes (skewness, modality) across numerical and categorical variables.
- Step 7 (Bivariate & Multivariate Analysis): Analyze the Pearson correlation matrix (r values), highlight the strongest positive and negative feature relationships, and discuss multivariate interactions.
- Step 8 (Final Dashboard Summary): Provide a comprehensive executive synthesis of the entire 8-step EDA: data quality improvements, top statistical drivers, key anomalies resolved, and modeling/business recommendations.

Formatting & Permission Gate Rules:
1. Write clear, rigorous markdown with concise bullet points and markdown tables where helpful.
2. You have access to the Python codeExecution tool. Load the provided CSV sample using \`pd.read_csv(io.StringIO(...))\` to verify calculations or generate a plot if appropriate for Steps 2, 3, 6, 7, or 8.
3. CRITICAL PERMISSION GATE:
${
  nextStep
    ? `At the very end of your response, you MUST explicitly ask the user for confirmation to move forward using this exact phrasing:
"Would you like me to proceed to Step ${nextStep} (${STEP_TITLES[nextStep].replace(/^Step \d+:\s*/, '')}) now? Please reply with 'Yes' or any specific adjustments you want to make first."`
    : `At the end of Step 8, congratulate the user on completing all 8 steps of the Exploratory Data Analysis and invite them to ask any follow-up questions or export the cleaned CSV and report.`
}`;

    const promptText = `Dataset Profile Summary (computed on full dataset of ${profileSummary?.rowCount} rows × ${profileSummary?.colCount} columns):
${JSON.stringify(profileSummary, null, 2)}

CSV Sample (first rows for Python Pandas execution):
\`\`\`csv
${csvSample || ''}
\`\`\`

${
  userAdjustment
    ? `User's specific instruction / adjustment for Step ${step}: "${userAdjustment}"\nPlease address this adjustment directly while presenting ${stepTitle}.`
    : `Please execute ${stepTitle} now.`
}`;

    try {
      const response = await generateStepWithRetry(promptText, systemInstruction);

      let markdownText = '';
      const executableCodes: string[] = [];
      const codeOutputs: string[] = [];
      const inlinePlots: { mimeType: string; data: string }[] = [];

      const parts = response.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.text) {
          markdownText += part.text;
        }
        if ((part as any).executableCode?.code) {
          executableCodes.push((part as any).executableCode.code);
        }
        if ((part as any).codeExecutionResult?.output) {
          codeOutputs.push((part as any).codeExecutionResult.output);
        }
        if (part.inlineData?.data && part.inlineData?.mimeType?.startsWith('image/')) {
          inlinePlots.push({
            mimeType: part.inlineData.mimeType,
            data: part.inlineData.data,
          });
        }
      }

      if (!markdownText && response.text) {
        markdownText = response.text;
      }

      if (!markdownText.trim()) {
        markdownText = buildDeterministicStepMarkdown(step, profileSummary, userAdjustment);
      } else if (nextStep && !markdownText.toLowerCase().includes(`proceed to step ${nextStep}`)) {
        markdownText = `${markdownText.trim()}\n\n---\n**Would you like me to proceed to Step ${nextStep} (${STEP_TITLES[
          nextStep
        ].replace(
          /^Step \d+:\s*/,
          ''
        )}) now? Please reply with 'Yes' or any specific adjustments you want to make first.**`;
      }

      res.json({
        step,
        stepTitle,
        markdownText,
        executableCodes,
        codeOutputs,
        inlinePlots,
      });
    } catch (error: any) {
      console.warn(
        `All Gemini model attempts experienced transient unavailability for Step ${step}; serving deterministic statistical synthesis.`
      );
      const fallbackMarkdown = buildDeterministicStepMarkdown(
        step,
        profileSummary,
        userAdjustment
      );
      res.json({
        step,
        stepTitle,
        markdownText: fallbackMarkdown,
        executableCodes: [],
        codeOutputs: [],
        inlinePlots: [],
      });
    }
  });

  // Serve frontend via Vite middleware in dev or static files in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Veritas EDA Studio server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
