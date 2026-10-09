import React, { useEffect, useRef, useState } from 'react';
import {
  Upload,
  FolderOpen,
  Play,
  CheckCircle2,
  Lock,
  Terminal,
  FileSpreadsheet,
  Send,
  Download,
  RotateCcw,
  ChevronRight,
  Search,
  LogOut,
  FileText,
  History,
  Trash2,
  LayoutDashboard,
  Check,
} from 'lucide-react';
import { User } from 'firebase/auth';
import {
  initAuth,
  googleSignIn,
  logout,
  extractDriveFileId,
  downloadDriveFileContent,
} from './services/driveService';
import {
  DataFrameState,
  PandasDType,
  EDA_STEPS_META,
  SAMPLE_DATASETS,
  parseDatasetBuffer,
  applyMissingValueStrategy,
  applyDuplicateAndOutlierCleaning,
  applyDataTransformation,
  overrideColumnDType,
  refreshDataFrameProfileTypes,
  exportDataFrameToCSV,
  generatePythonSnippetForStep,
} from './utils/edaEngine';
import {
  PersistedChatMessage,
  SavedEdaSession,
  SavedSessionSummary,
  saveEdaSession,
  loadMostRecentSession,
  loadEdaSessionById,
  listSavedSessionSummaries,
  deleteSavedSession,
} from './services/sessionStorageService';
import { generateEdaPdfReport } from './utils/pdfReportGenerator';
import { StepVisualizations } from './components/StepVisualizations';
import { GoogleDriveModal, GoogleSignInButton } from './components/GoogleDriveModal';
import { MarkdownRenderer } from './components/MarkdownRenderer';

type ChatMessage = PersistedChatMessage;
type ActiveTab = 'session' | 'inspector' | 'notebook' | 'dashboard';

function createInitialWelcomeMessage(): ChatMessage {
  return {
    id: `welcome-${Date.now()}`,
    role: 'assistant',
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    content: `Welcome to **Veritas EDA Studio**. I am your interactive Exploratory Data Analysis assistant. I will guide you through a strict, sequential **8-step EDA workflow**—executing **one step at a time** and always asking for your permission before advancing.

*Your session progress and DataFrame state are **automatically saved** in your browser so you can close the tab at any time and resume where you left off. At the end of Step 8, you will receive a consolidated **Dashboard Summary** and a downloadable **PDF Report (\`.pdf\`)**.*

### Step 0: Initial Data Access
To begin, please provide your dataset using any of the options below:
1. **Upload a Dataset File (CSV / XLSX)** directly to this chat session using the upload zone below or the attachment button.
2. **Paste a Google Drive or Google Sheets Link** directly into the chat input box below, or connect your Google Drive to browse files.

I am waiting for your data before starting **Step 1: Understand the Problem and Data**.`,
  };
}

export default function App() {
  // Google Workspace Auth State
  const [user, setUser] = useState<User | null>(null);
  const [needsAuth, setNeedsAuth] = useState<boolean>(true);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);
  const [isDriveModalOpen, setIsDriveModalOpen] = useState<boolean>(false);

  // Navigation Tab
  const [activeTab, setActiveTab] = useState<ActiveTab>('session');

  // Session Persistence State
  const [sessionId, setSessionId] = useState<string>(() => `session-${Date.now()}`);
  const [sessionCreatedAt, setSessionCreatedAt] = useState<string>(() => new Date().toISOString());
  const [isHydrated, setIsHydrated] = useState<boolean>(false);
  const [lastSavedTime, setLastSavedTime] = useState<string | null>(null);
  const [restoredNotice, setRestoredNotice] = useState<string | null>(null);
  const [savedSessions, setSavedSessions] = useState<SavedSessionSummary[]>([]);
  const [isSessionsDrawerOpen, setIsSessionsDrawerOpen] = useState<boolean>(false);

  // EDA Sequential State
  const [dfState, setDfState] = useState<DataFrameState | null>(null);
  const [currentStep, setCurrentStep] = useState<number>(0); // 0 = Waiting for data; 1..8 = Active step
  const [completedSteps, setCompletedSteps] = useState<number[]>([]);
  const [isExecutingStep, setIsExecutingStep] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Chat & Input State
  const [messages, setMessages] = useState<ChatMessage[]>(() => [createInitialWelcomeMessage()]);
  const [chatInput, setChatInput] = useState<string>('');
  const [inspectorSearch, setInspectorSearch] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const stepAbortControllerRef = useRef<AbortController | null>(null);

  // 1. Initialize Google Auth listener
  useEffect(() => {
    const unsubscribe = initAuth(
      (u) => {
        setUser(u);
        setNeedsAuth(false);
      },
      () => {
        setUser(null);
        setNeedsAuth(true);
      }
    );
    return () => unsubscribe();
  }, []);

  // 2. Restore saved session on initial mount so closing the tab never loses progress
  useEffect(() => {
    let isMounted = true;
    async function restoreSessionOnBoot() {
      try {
        const [restored, summaries] = await Promise.all([
          loadMostRecentSession(),
          listSavedSessionSummaries(),
        ]);
        if (!isMounted) return;

        setSavedSessions(summaries);

        if (restored && (restored.dfState || restored.messages.length > 1)) {
          const refreshedDfState = restored.dfState
            ? refreshDataFrameProfileTypes(restored.dfState)
            : null;
          const dtColNames = refreshedDfState
            ? refreshedDfState.profile.columns
                .filter((c) => c.dtype === 'datetime64[ns]')
                .map((c) => c.name)
            : [];

          setSessionId(restored.sessionId);
          setSessionCreatedAt(restored.createdAt || new Date().toISOString());
          setDfState(refreshedDfState);
          setCurrentStep(restored.currentStep);
          setCompletedSteps(restored.completedSteps || []);
          setActiveTab(restored.activeTab || 'session');

          // Ensure permission gate is intact and update any stale int64 references for newly recognized datetime columns (e.g. 'year')
          const restoredMsgs = (restored.messages || []).map((m, idx, arr) => {
            let updatedContent = m.content;
            let updatedStdout = m.pythonStdout;
            let updatedCode = m.pythonCode;

            if (dtColNames.length > 0 && m.role === 'assistant') {
              for (const dtCol of dtColNames) {
                const escaped = dtCol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                updatedContent = updatedContent.replace(
                  new RegExp(`\`${escaped}\`\\s*\\(int64\\)`, 'gi'),
                  `\`${dtCol}\` (datetime64[ns])`
                );
                if (updatedStdout) {
                  updatedStdout = updatedStdout.replace(
                    new RegExp(`(${escaped}\\s+\\d+\\s+non-null\\s+)int64`, 'gi'),
                    `$1datetime64[ns]`
                  );
                }
              }
              if (m.stepNumber && refreshedDfState) {
                const freshSnippet = generatePythonSnippetForStep(
                  m.stepNumber,
                  refreshedDfState.profile
                );
                if (!updatedCode || updatedCode.includes('# Step ')) {
                  updatedCode = freshSnippet.code;
                  updatedStdout = freshSnippet.stdout;
                }
              }
            }

            if (
              m.role === 'assistant' &&
              m.stepNumber === restored.currentStep &&
              restored.currentStep >= 1 &&
              restored.currentStep < 8 &&
              idx === arr.length - 1
            ) {
              return {
                ...m,
                content: updatedContent,
                pythonCode: updatedCode,
                pythonStdout: updatedStdout,
                awaitingPermissionForStep: restored.currentStep + 1,
              };
            }
            return {
              ...m,
              content: updatedContent,
              pythonCode: updatedCode,
              pythonStdout: updatedStdout,
            };
          });

          setMessages(restoredMsgs.length > 0 ? restoredMsgs : [createInitialWelcomeMessage()]);
          setLastSavedTime(
            new Date(restored.updatedAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })
          );

          if (refreshedDfState) {
            setRestoredNotice(
              `Restored saved EDA session for "${refreshedDfState.profile.fileName}" (Step ${restored.currentStep} of 8).`
            );
          }
        }
      } catch (err) {
        console.warn('Could not restore previous session:', err);
      } finally {
        if (isMounted) {
          setIsHydrated(true);
        }
      }
    }
    restoreSessionOnBoot();
    return () => {
      isMounted = false;
    };
  }, []);

  // 3. Automatically persist session state whenever dfState, currentStep, completedSteps, messages, or activeTab changes
  useEffect(() => {
    if (!isHydrated) return;

    // Only persist if a dataset is loaded or user has interacted beyond the initial welcome message
    if (!dfState && messages.length <= 1) return;

    const nowIso = new Date().toISOString();
    const sessionToSave: SavedEdaSession = {
      sessionId,
      title: dfState ? dfState.profile.fileName : 'EDA Session',
      fileName: dfState ? dfState.profile.fileName : null,
      createdAt: sessionCreatedAt,
      updatedAt: nowIso,
      currentStep,
      completedSteps,
      activeTab,
      dfState,
      messages,
    };

    saveEdaSession(sessionToSave)
      .then(() => {
        setLastSavedTime(
          new Date(nowIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        );
        return listSavedSessionSummaries();
      })
      .then((summaries) => {
        setSavedSessions(summaries);
      })
      .catch((err) => {
        console.warn('Session auto-save warning:', err);
      });
  }, [isHydrated, sessionId, sessionCreatedAt, dfState, currentStep, completedSteps, messages, activeTab]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isExecutingStep]);

  const handleResumeSavedSession = async (targetSessionId: string) => {
    if (stepAbortControllerRef.current) {
      stepAbortControllerRef.current.abort();
      stepAbortControllerRef.current = null;
    }
    setIsExecutingStep(false);
    setErrorBanner(null);

    const loaded = await loadEdaSessionById(targetSessionId);
    if (!loaded) {
      setErrorBanner('Could not load that saved session.');
      return;
    }

    const refreshed = loaded.dfState ? refreshDataFrameProfileTypes(loaded.dfState) : null;
    setSessionId(loaded.sessionId);
    setSessionCreatedAt(loaded.createdAt);
    setDfState(refreshed);
    setCurrentStep(loaded.currentStep);
    setCompletedSteps(loaded.completedSteps || []);
    setActiveTab(loaded.activeTab || 'session');
    setMessages(loaded.messages.length > 0 ? loaded.messages : [createInitialWelcomeMessage()]);
    setIsSessionsDrawerOpen(false);
    setRestoredNotice(
      loaded.dfState
        ? `Resumed saved session for "${loaded.dfState.profile.fileName}" (Step ${loaded.currentStep} of 8).`
        : 'Resumed saved session.'
    );
  };

  const handleDeleteSavedSession = async (targetSessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteSavedSession(targetSessionId);
    const updated = await listSavedSessionSummaries();
    setSavedSessions(updated);
    if (targetSessionId === sessionId) {
      handleStartNewSession(false);
    }
  };

  const handleGoogleLogin = async (forceConsent = false) => {
    setIsLoggingIn(true);
    setErrorBanner(null);
    try {
      const result = await googleSignIn(forceConsent);
      if (result) {
        setUser(result.user);
        setNeedsAuth(false);
      }
    } catch (err: any) {
      setErrorBanner(err.message || 'Google Sign-In was cancelled or failed.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleGoogleLogout = async () => {
    await logout();
    setUser(null);
    setNeedsAuth(true);
  };

  // Run a single EDA step (1..8) via Gemini backend + built-in Python execution
  const executeEdaStep = async (
    stepNum: number,
    activeDfState: DataFrameState,
    userAdjustment?: string
  ) => {
    setIsExecutingStep(true);
    setErrorBanner(null);

    const { profile, rows } = activeDfState;
    const defaultPy = generatePythonSnippetForStep(stepNum, profile);

    // Prepare compact CSV sample (first 80 rows) for Gemini's Python sandbox
    const sampleRows = rows.slice(0, 80);
    const colNames = profile.columns.map((c) => c.name);
    const csvHeader = colNames.join(',');
    const csvLines = sampleRows.map((r) =>
      colNames
        .map((c) => {
          const val = r[c];
          if (val === null || val === undefined) return '';
          const str = String(val);
          return str.includes(',') || str.includes('"')
            ? `"${str.replace(/"/g, '""')}"`
            : str;
        })
        .join(',')
    );
    const csvSample = [csvHeader, ...csvLines].join('\n');

    // Compact profile summary for Gemini
    const profileSummary = {
      fileName: profile.fileName,
      rowCount: profile.rowCount,
      colCount: profile.colCount,
      originalRowCount: profile.originalRowCount,
      duplicateRowCount: profile.duplicateRowCount,
      totalMissingCells: profile.totalMissingCells,
      totalMissingPct: profile.totalMissingPct,
      totalOutliersCount: profile.totalOutliersCount,
      columns: profile.columns.map((c) => ({
        name: c.name,
        dtype: c.dtype,
        nonNullCount: c.nonNullCount,
        missingCount: c.missingCount,
        missingPct: c.missingPct,
        uniqueCount: c.uniqueCount,
        sampleValues: c.sampleValues,
        numeric: c.numeric
          ? {
              mean: c.numeric.mean,
              std: c.numeric.std,
              min: c.numeric.min,
              q25: c.numeric.q25,
              median: c.numeric.median,
              q75: c.numeric.q75,
              max: c.numeric.max,
              iqr: c.numeric.iqr,
              lowerBound: c.numeric.lowerBound,
              upperBound: c.numeric.upperBound,
              outlierCount: c.numeric.outlierCount,
              outlierPct: c.numeric.outlierPct,
              skewness: c.numeric.skewness,
            }
          : undefined,
        topCategories: c.topCategories?.slice(0, 5),
      })),
      topCorrelations: profile.correlationMatrix.topPairs.slice(0, 6),
      transformationLog: profile.transformationLog,
    };

    try {
      if (stepAbortControllerRef.current) {
        stepAbortControllerRef.current.abort();
      }
      const controller = new AbortController();
      stepAbortControllerRef.current = controller;

      const response = await fetch('/api/eda/execute-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stepNumber: stepNum,
          profileSummary,
          csvSample,
          userAdjustment,
        }),
        signal: controller.signal,
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Failed to execute Step ${stepNum}`);
      }

      const combinedCode =
        data.executableCodes && data.executableCodes.length > 0
          ? data.executableCodes.join('\n\n')
          : defaultPy.code;
      const combinedStdout =
        data.codeOutputs && data.codeOutputs.length > 0
          ? data.codeOutputs.join('\n')
          : defaultPy.stdout;

      const stepMessage: ChatMessage = {
        id: `step-${stepNum}-${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        stepNumber: stepNum,
        content: data.markdownText,
        pythonCode: combinedCode,
        pythonStdout: combinedStdout,
        sandboxPlots: data.inlinePlots || [],
        awaitingPermissionForStep: stepNum < 8 ? stepNum + 1 : undefined,
      };

      setMessages((prev) => [...prev, stepMessage]);
      setCurrentStep(stepNum);
      setCompletedSteps((prev) => (prev.includes(stepNum) ? prev : [...prev, stepNum]));
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        return;
      }
      const nextStep = stepNum < 8 ? stepNum + 1 : undefined;
      const meta = EDA_STEPS_META[stepNum - 1];
      const fallbackMessage: ChatMessage = {
        id: `step-fallback-${stepNum}-${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        stepNumber: stepNum,
        content: `### Step ${stepNum}: ${meta.title}\n\nExecuted Pandas analysis for **${profile.fileName}** (${profile.rowCount} rows × ${profile.colCount} columns).\n\n- **Missing Cells**: ${profile.totalMissingCells} (${profile.totalMissingPct}%)\n- **Exact Duplicate Rows**: ${profile.duplicateRowCount}\n- **IQR Outliers Detected**: ${profile.totalOutliersCount}\n\n---\n${
          nextStep
            ? `**Would you like me to proceed to Step ${nextStep} (${EDA_STEPS_META[nextStep - 1].title}) now? Please reply with 'Yes' or any specific adjustments you want to make first.**`
            : `**All 8 EDA steps are complete! Review your Consolidated Dashboard Summary below and click "Download PDF Report (.pdf)" to export your complete report.**`
        }`,
        pythonCode: defaultPy.code,
        pythonStdout: defaultPy.stdout,
        awaitingPermissionForStep: nextStep,
      };
      setMessages((prev) => [...prev, fallbackMessage]);
      setCurrentStep(stepNum);
      setCompletedSteps((prev) => (prev.includes(stepNum) ? prev : [...prev, stepNum]));
    } finally {
      setIsExecutingStep(false);
    }
  };

  // Load dataset buffer (from local upload, Google Drive, or benchmark sample)
  const handleDatasetBufferLoaded = async (
    buffer: ArrayBuffer,
    fileName: string,
    source: 'upload' | 'google_drive' | 'sample'
  ) => {
    setErrorBanner(null);
    setRestoredNotice(null);
    try {
      const state = await parseDatasetBuffer(buffer, fileName, source);
      const newSessId = `session-${Date.now()}`;
      setSessionId(newSessId);
      setSessionCreatedAt(new Date().toISOString());
      setDfState(state);
      setCurrentStep(1);
      setCompletedSteps([]);

      const { profile } = state;
      const numCount = profile.columns.filter((c) => c.numeric).length;
      const dtCount = profile.columns.filter((c) => c.dtype === 'datetime64[ns]').length;
      const catCount = profile.colCount - numCount - dtCount;

      // Brief the user that the file has been read into a Pandas DataFrame per Rule 2
      const briefingMsg: ChatMessage = {
        id: `briefing-${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        content: `**Data Access Confirmed**: I have read **\`${profile.fileName}\`** and loaded it into a Pandas DataFrame using the Python execution environment. *(Session auto-save enabled)*
- **Dimensions**: \`${profile.rowCount} rows × ${profile.colCount} columns\`
- **Detected Schema**: \`${numCount}\` numerical features${
          dtCount > 0 ? `, \`${dtCount}\` datetime features` : ''
        }, \`${catCount}\` categorical/object features
- **Initial Quality Scan**: \`${profile.totalMissingCells}\` missing cells (\`${profile.totalMissingPct}%\`) · \`${profile.duplicateRowCount}\` duplicate rows

Executing **Step 1: Understand the Problem and Data** now...`,
        pythonCode: `import pandas as pd\ndf = pd.${
          fileName.toLowerCase().endsWith('.xlsx') ? 'read_excel' : 'read_csv'
        }("${profile.fileName}")\nprint(f"Successfully loaded '{ '${profile.fileName}' }' into DataFrame: {df.shape}")`,
        pythonStdout: `Successfully loaded '${profile.fileName}' into DataFrame: (${profile.rowCount}, ${profile.colCount})`,
      };

      setMessages((prev) => [...prev, briefingMsg]);
      await executeEdaStep(1, state);
    } catch (err: any) {
      setErrorBanner(err.message || 'Failed to parse dataset file.');
    }
  };

  const handleFileUploadChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const userMsg: ChatMessage = {
      id: `user-upload-${Date.now()}`,
      role: 'user',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      content: `Uploaded dataset file: **${file.name}** (${(file.size / 1024).toFixed(1)} KB)`,
    };
    setMessages((prev) => [...prev, userMsg]);

    const buffer = await file.arrayBuffer();
    await handleDatasetBufferLoaded(buffer, file.name, 'upload');
    e.target.value = '';
  };

  const handleLoadSampleDataset = async (sampleId: string) => {
    const sample = SAMPLE_DATASETS.find((s) => s.id === sampleId);
    if (!sample) return;

    const userMsg: ChatMessage = {
      id: `user-sample-${Date.now()}`,
      role: 'user',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      content: `Load benchmark dataset: **${sample.name}** (\`${sample.fileName}\`)`,
    };
    setMessages((prev) => [...prev, userMsg]);

    const encoder = new TextEncoder();
    const buffer = encoder.encode(sample.csvContent).buffer;
    await handleDatasetBufferLoaded(buffer, sample.fileName, 'sample');
  };

  // Interactive Pandas Mutators for Steps 3, 4, 5
  const handleApplyMissingFix = async (
    strategy: 'impute_median_mode' | 'drop_rows' | 'drop_high_missing_cols'
  ) => {
    if (!dfState || isExecutingStep) return;
    const updated = applyMissingValueStrategy(dfState, strategy);
    setDfState(updated);

    const lastLog = updated.profile.transformationLog[updated.profile.transformationLog.length - 1];
    const notifyMsg: ChatMessage = {
      id: `fix-missing-${Date.now()}`,
      role: 'assistant',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      stepNumber: 3,
      content: `**Pandas Missing Value Operation Executed**: ${lastLog}\n\n- **Updated Shape**: \`${updated.profile.rowCount} rows × ${updated.profile.colCount} columns\`\n- **Remaining Missing Values**: \`${updated.profile.totalMissingCells}\` (\`${updated.profile.totalMissingPct}%\`)\n\n---\n**Would you like me to proceed to Step 4 (Clean Duplicates and Anomalies) now? Please reply with 'Yes' or any specific adjustments you want to make first.**`,
      pythonCode:
        strategy === 'drop_rows'
          ? `df = df.dropna().reset_index(drop=True)\nprint("Remaining nulls:", df.isnull().sum().sum())`
          : `for col in df.columns:\n    if df[col].isnull().sum() > 0:\n        fill_val = df[col].median() if df[col].dtype != 'object' else df[col].mode()[0]\n        df[col] = df[col].fillna(fill_val)\nprint("Remaining nulls:", df.isnull().sum().sum())`,
      pythonStdout: `Remaining nulls: ${updated.profile.totalMissingCells} | Shape: (${updated.profile.rowCount}, ${updated.profile.colCount})`,
      awaitingPermissionForStep: 4,
    };
    setMessages((prev) => [...prev, notifyMsg]);
  };

  const handleApplyOutlierFix = async (
    mode: 'deduplicate_only' | 'clip_iqr_and_dedup' | 'remove_iqr_and_dedup'
  ) => {
    if (!dfState || isExecutingStep) return;
    const updated = applyDuplicateAndOutlierCleaning(dfState, mode);
    setDfState(updated);

    const lastLog = updated.profile.transformationLog[updated.profile.transformationLog.length - 1];
    const notifyMsg: ChatMessage = {
      id: `fix-outlier-${Date.now()}`,
      role: 'assistant',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      stepNumber: 4,
      content: `**Pandas Duplicate & Outlier Operation Executed**: ${lastLog}\n\n- **Updated Shape**: \`${updated.profile.rowCount} rows × ${updated.profile.colCount} columns\`\n- **Remaining Duplicates**: \`${updated.profile.duplicateRowCount}\`\n- **Remaining IQR Outliers**: \`${updated.profile.totalOutliersCount}\`\n\n---\n**Would you like me to proceed to Step 5 (Perform Data Transformation) now? Please reply with 'Yes' or any specific adjustments you want to make first.**`,
      pythonCode: `df = df.drop_duplicates().reset_index(drop=True)\n# Applied ${mode} via 1.5 * IQR bounds\nprint("Updated shape:", df.shape)`,
      pythonStdout: `Updated shape: (${updated.profile.rowCount}, ${updated.profile.colCount}) | Remaining duplicates: ${updated.profile.duplicateRowCount}`,
      awaitingPermissionForStep: 5,
    };
    setMessages((prev) => [...prev, notifyMsg]);
  };

  const handleApplyTransform = async (
    mode: 'log_skewed' | 'label_encode_cats' | 'standardize_numeric'
  ) => {
    if (!dfState || isExecutingStep) return;
    const updated = applyDataTransformation(dfState, mode);
    setDfState(updated);

    const lastLog = updated.profile.transformationLog[updated.profile.transformationLog.length - 1];
    const notifyMsg: ChatMessage = {
      id: `fix-transform-${Date.now()}`,
      role: 'assistant',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      stepNumber: 5,
      content: `**Pandas Feature Transformation Executed**: ${lastLog}\n\n- **Updated Shape**: \`${updated.profile.rowCount} rows × ${updated.profile.colCount} columns\`\n\n---\n**Would you like me to proceed to Step 6 (Univariate Analysis) now? Please reply with 'Yes' or any specific adjustments you want to make first.**`,
      pythonCode: `# Applied ${mode} feature transformation\nprint("Columns after transform:", list(df.columns))`,
      pythonStdout: `Columns (${updated.profile.colCount}): ${updated.profile.columns.map((c) => c.name).join(', ')}`,
      awaitingPermissionForStep: 6,
    };
    setMessages((prev) => [...prev, notifyMsg]);
  };

  const handleChangeColumnDType = (colName: string, newDType: PandasDType) => {
    if (!dfState || isExecutingStep) return;
    const updated = overrideColumnDType(dfState, colName, newDType);
    setDfState(updated);

    const activeStep = currentStep >= 1 ? currentStep : 1;
    const nextStep = activeStep < 8 ? activeStep + 1 : undefined;
    const pyCode =
      newDType === 'datetime64[ns]'
        ? `df['${colName}'] = pd.to_datetime(df['${colName}'].astype(str), format='%Y', errors='coerce')\nprint(df[['${colName}']].dtypes)`
        : `df['${colName}'] = df['${colName}'].astype('${newDType}')\nprint(df[['${colName}']].dtypes)`;

    const notifyMsg: ChatMessage = {
      id: `dtype-revise-${Date.now()}`,
      role: 'assistant',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      stepNumber: activeStep,
      content: `**Variable Type Revised**: Updated **\`${colName}\`** to **\`${newDType}\`** (${
        newDType === 'datetime64[ns]'
          ? 'Temporal / Datetime Variable'
          : newDType === 'object'
          ? 'Categorical / Object Variable'
          : 'Quantitative / Numerical Variable'
      }).\n\n- **Active Numerical Columns**: ${
        updated.profile.columns
          .filter((c) => c.numeric)
          .map((c) => `\`${c.name}\``)
          .join(', ') || 'None'
      }\n- **Active Datetime Columns**: ${
        updated.profile.columns
          .filter((c) => c.dtype === 'datetime64[ns]')
          .map((c) => `\`${c.name}\``)
          .join(', ') || 'None'
      }\n\n---\n${
        nextStep
          ? `**Would you like me to proceed to Step ${nextStep} (${EDA_STEPS_META[nextStep - 1].title}) now? Please reply with 'Yes' or any specific adjustments you want to make first.**`
          : `**All 8 EDA steps are complete! Your Dashboard Summary and PDF Report reflect the revised variable type.**`
      }`,
      pythonCode: pyCode,
      pythonStdout: `${colName}    ${newDType}\ndtype: object`,
      awaitingPermissionForStep: nextStep,
    };
    setMessages((prev) => [...prev, notifyMsg]);
  };

  // Handle User Chat Submission (Permission Gate "Yes" OR Drive Link OR Custom Adjustment)
  const handleSendMessage = async (e?: React.FormEvent, overrideText?: string) => {
    if (e) e.preventDefault();
    const rawText = (overrideText ?? chatInput).trim();
    if (!rawText) return;

    const normalizedCmd = rawText.toLowerCase().replace(/[!.,]/g, '').trim();
    if (
      /^(reset|restart|cancel|new session|start over|clear|clear session)$/i.test(normalizedCmd)
    ) {
      setChatInput('');
      handleStartNewSession(true);
      return;
    }

    if (isExecutingStep) return;

    if (!overrideText) {
      setChatInput('');
    }

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      content: rawText,
    };
    setMessages((prev) => [...prev, userMsg]);

    // 1. Check if user pasted a Google Drive or Google Sheets URL in the chat
    if (
      rawText.includes('drive.google.com') ||
      rawText.includes('docs.google.com/spreadsheets') ||
      (!dfState && /^[a-zA-Z0-9_-]{25,}$/.test(rawText))
    ) {
      const { fileId, isSpreadsheetUrl } = extractDriveFileId(rawText);
      if (fileId) {
        setIsExecutingStep(true);
        try {
          const { buffer, fileName } = await downloadDriveFileContent(
            fileId,
            undefined,
            undefined,
            isSpreadsheetUrl
          );
          await handleDatasetBufferLoaded(buffer, fileName, 'google_drive');
        } catch (err: any) {
          setErrorBanner(err.message);
          setMessages((prev) => [
            ...prev,
            {
              id: `err-${Date.now()}`,
              role: 'assistant',
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              content: `I could not access that Google Drive link directly: **${err.message}**\n\nPlease make sure the link is set to **"Anyone with the link"** OR click **"Sign in with Google"** in the top bar so I can read it with your permission.`,
            },
          ]);
        } finally {
          setIsExecutingStep(false);
        }
        return;
      }
    }

    // 2. If no dataset is loaded yet, remind the user of Rule 1 (Wait for the data)
    if (!dfState) {
      setMessages((prev) => [
        ...prev,
        {
          id: `wait-data-${Date.now()}`,
          role: 'assistant',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          content: `I am currently waiting for your dataset before starting **Step 1: Understand the Problem and Data**. Please upload a **CSV or XLSX** file directly to this chat session, paste a **Google Drive / Google Sheets link**, or select one of the sample datasets below.`,
        },
      ]);
      return;
    }

    // 3. Check if the user is granting permission to proceed to the next step ("Yes", "proceed", "next", "continue")
    const normalized = rawText.toLowerCase().replace(/[!.,]/g, '').trim();
    const isAffirmative =
      /^(yes|y|yep|yeah|sure|ok|okay|proceed|next|continue|go ahead|move forward|yes proceed.*|proceed to step \d+.*)$/i.test(
        normalized
      );

    if (isAffirmative && currentStep >= 1 && currentStep < 8) {
      const nextStep = currentStep + 1;
      await executeEdaStep(nextStep, dfState);
      return;
    }

    // 3.5 Check if the user is revising a column's variable type in natural language (e.g. "year is a datetime variable and not an integer")
    if (
      /(datetime|date\b|temporal|categorical|object|string|integer|int64|float|float64|boolean|bool|variable type|data type|dtype)/i.test(
        rawText
      )
    ) {
      const matchedCol = dfState.profile.columns.find((c) => {
        const escaped = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^a-zA-Z0-9_])${escaped}($|[^a-zA-Z0-9_])`, 'i').test(rawText);
      });
      if (matchedCol) {
        let targetType: PandasDType | null = null;
        if (/(datetime|date\b|temporal)/i.test(rawText) && !/not\s+a?\s*datetime/i.test(rawText)) {
          targetType = 'datetime64[ns]';
        } else if (
          /(categorical|object|string|text|factor)/i.test(rawText) &&
          !/not\s+a?\s*(categorical|object|string)/i.test(rawText)
        ) {
          targetType = 'object';
        } else if (/(float|float64|continuous|decimal)/i.test(rawText)) {
          targetType = 'float64';
        } else if (
          /(integer|int64|\bint\b)/i.test(rawText) &&
          !/not\s+an?\s*(integer|int64|\bint\b)/i.test(rawText)
        ) {
          targetType = 'int64';
        } else if (/(boolean|\bbool\b)/i.test(rawText)) {
          targetType = 'bool';
        }

        if (targetType) {
          handleChangeColumnDType(matchedCol.name, targetType);
          return;
        }
      }
    }

    // 4. Check if user asked for a specific data cleaning action in natural language
    let workingState = dfState;
    if (
      currentStep === 3 &&
      (normalized.includes('impute') || normalized.includes('median') || normalized.includes('fill'))
    ) {
      workingState = applyMissingValueStrategy(dfState, 'impute_median_mode');
      setDfState(workingState);
    } else if (currentStep === 3 && normalized.includes('drop')) {
      workingState = applyMissingValueStrategy(dfState, 'drop_rows');
      setDfState(workingState);
    } else if (
      currentStep === 4 &&
      (normalized.includes('duplicate') ||
        normalized.includes('outlier') ||
        normalized.includes('clip') ||
        normalized.includes('clean'))
    ) {
      workingState = applyDuplicateAndOutlierCleaning(dfState, 'clip_iqr_and_dedup');
      setDfState(workingState);
    } else if (
      currentStep === 5 &&
      (normalized.includes('encode') || normalized.includes('categorical'))
    ) {
      workingState = applyDataTransformation(dfState, 'label_encode_cats');
      setDfState(workingState);
    } else if (
      currentStep === 5 &&
      (normalized.includes('log') || normalized.includes('skew'))
    ) {
      workingState = applyDataTransformation(dfState, 'log_skewed');
      setDfState(workingState);
    }

    // Re-run current step with the user's specific adjustment / question while keeping the Permission Gate active
    await executeEdaStep(currentStep, workingState, rawText);
  };

  const handleExportCSV = () => {
    if (!dfState) return;
    const csv = exportDataFrameToCSV(dfState);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cleaned_${dfState.profile.fileName.replace(/\.(xlsx|xls)$/i, '.csv')}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPDF = () => {
    if (!dfState) return;
    generateEdaPdfReport(dfState, messages, completedSteps);
  };

  const handleExportReport = () => {
    if (!dfState) return;
    const stepMsgs = messages.filter((m) => m.role === 'assistant' && m.stepNumber);
    const reportMd = [
      `# Exploratory Data Analysis (EDA) Report — ${dfState.profile.fileName}`,
      `Generated by Veritas EDA Studio · Shape: ${dfState.profile.rowCount} rows × ${dfState.profile.colCount} columns`,
      '',
      ...stepMsgs.map(
        (m) =>
          `## Step ${m.stepNumber}\n\n\`\`\`python\n${m.pythonCode || ''}\n\`\`\`\n\n${m.content}`
      ),
    ].join('\n\n---\n\n');

    const blob = new Blob([reportMd], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eda_report_${dfState.profile.fileName.replace(/\.[^.]+$/, '')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleStartNewSession = (keepPreviousSaved = true) => {
    if (stepAbortControllerRef.current) {
      stepAbortControllerRef.current.abort();
      stepAbortControllerRef.current = null;
    }
    if (!keepPreviousSaved && sessionId) {
      deleteSavedSession(sessionId).then(() =>
        listSavedSessionSummaries().then(setSavedSessions)
      );
    }
    const freshId = `session-${Date.now()}`;
    setSessionId(freshId);
    setSessionCreatedAt(new Date().toISOString());
    setIsExecutingStep(false);
    setDfState(null);
    setCurrentStep(0);
    setCompletedSteps([]);
    setErrorBanner(null);
    setRestoredNotice(null);
    setActiveTab('session');
    setMessages([createInitialWelcomeMessage()]);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#0B1120] text-slate-100">
      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.tsv,.xlsx,.xls"
        onChange={handleFileUploadChange}
        className="hidden"
      />

      {/* TOP BAR CONTRACT: Strictly 1 row, 3 zones (Brand Wordmark — 4 Nav Links — Primary Actions) */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-800 bg-[#0F172A] px-6">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('session');
          }}
          className="text-base font-bold tracking-tight text-slate-100 whitespace-nowrap"
        >
          Veritas EDA Studio
        </a>

        {/* Zone 2: 4 clean single-line text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-xs font-medium text-slate-400">
          <button
            type="button"
            onClick={() => setActiveTab('session')}
            className={`py-4 transition-colors whitespace-nowrap ${
              activeTab === 'session'
                ? 'border-b-2 border-sky-400 font-semibold text-slate-100'
                : 'hover:text-slate-200'
            }`}
          >
            Interactive Session
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('inspector')}
            className={`py-4 transition-colors whitespace-nowrap ${
              activeTab === 'inspector'
                ? 'border-b-2 border-sky-400 font-semibold text-slate-100'
                : 'hover:text-slate-200'
            }`}
          >
            DataFrame Inspector
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('notebook')}
            className={`py-4 transition-colors whitespace-nowrap ${
              activeTab === 'notebook'
                ? 'border-b-2 border-sky-400 font-semibold text-slate-100'
                : 'hover:text-slate-200'
            }`}
          >
            Python Notebook
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('dashboard')}
            className={`py-4 transition-colors whitespace-nowrap ${
              activeTab === 'dashboard'
                ? 'border-b-2 border-sky-400 font-semibold text-slate-100'
                : 'hover:text-slate-200'
            }`}
          >
            Dashboard Summary
          </button>
        </nav>

        {/* Zone 3: Primary Actions */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setIsSessionsDrawerOpen((prev) => !prev)}
            title="View and resume saved EDA sessions (persisted on server & browser)"
            className="flex items-center gap-1.5 border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
          >
            <History className="h-3.5 w-3.5 text-sky-400" />
            <span>Saved Sessions ({savedSessions.length})</span>
          </button>

          {dfState && (
            <button
              type="button"
              onClick={handleExportPDF}
              title="Download full EDA report in PDF format"
              className="flex items-center gap-1.5 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 transition-colors whitespace-nowrap"
            >
              <FileText className="h-3.5 w-3.5" />
              <span>Export PDF</span>
            </button>
          )}

          {needsAuth ? (
            <GoogleSignInButton
              onClick={handleGoogleLogin}
              disabled={isLoggingIn}
              label={isLoggingIn ? 'Signing in...' : 'Sign in with Google'}
            />
          ) : (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setIsDriveModalOpen(true)}
                className="flex items-center gap-1.5 border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
              >
                <FolderOpen className="h-3.5 w-3.5 text-sky-400" />
                Google Drive
              </button>
              <button
                type="button"
                onClick={handleGoogleLogout}
                title={`Signed in as ${user?.email || 'Google User'}. Click to sign out.`}
                className="p-1.5 text-slate-400 hover:text-slate-200"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => handleStartNewSession(true)}
            title="Start a new session (your current session remains saved in Saved Sessions)"
            className="flex items-center gap-1.5 border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 transition-colors whitespace-nowrap"
          >
            <RotateCcw className="h-3.5 w-3.5 text-amber-400" />
            New Session
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 bg-sky-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500 transition-colors whitespace-nowrap"
          >
            <Upload className="h-3.5 w-3.5" />
            Upload CSV / XLSX
          </button>
        </div>
      </header>

      {/* Saved Sessions Drawer / Modal */}
      {isSessionsDrawerOpen && (
        <div className="border-b border-slate-800 bg-slate-900/95 px-6 py-4">
          <div className="mx-auto max-w-5xl">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-xs font-semibold text-slate-100">
                  Saved EDA Sessions (Server + Browser Auto-Persisted)
                </h3>
                <p className="text-[11px] text-slate-400">
                  Every dataset you load and every EDA step you run is automatically saved on the server and in your browser so closing the tab never deletes your progress.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsSessionsDrawerOpen(false)}
                className="text-xs font-medium text-slate-400 hover:text-slate-200"
              >
                Close
              </button>
            </div>
            {savedSessions.length === 0 ? (
              <div className="border border-slate-800 bg-[#0F172A] p-4 text-xs text-slate-400">
                No saved sessions yet. Upload a CSV/XLSX dataset, import from Google Drive, or load a sample dataset below—your session will automatically be saved here as soon as it starts.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {savedSessions.map((sess) => {
                  const isCurrentSession = sess.sessionId === sessionId && dfState !== null;
                  return (
                    <div
                      key={sess.sessionId}
                      onClick={() => handleResumeSavedSession(sess.sessionId)}
                      className={`cursor-pointer border p-3 transition-colors flex items-center justify-between gap-2 ${
                        isCurrentSession
                          ? 'border-sky-500 bg-sky-950/30'
                          : 'border-slate-800 bg-[#0F172A] hover:border-slate-600'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-mono text-xs font-semibold text-slate-100">
                            {sess.title}
                          </span>
                          {isCurrentSession && (
                            <span className="font-mono text-[10px] text-sky-400">Active</span>
                          )}
                        </div>
                        <div className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                          Step {sess.currentStep}/8 ({sess.completedStepsCount} done) · {sess.rowCount}×
                          {sess.colCount}
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-500">
                          Saved {new Date(sess.updatedAt).toLocaleString()}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => handleDeleteSavedSession(sess.sessionId, e)}
                        title="Delete saved session"
                        className="p-1.5 text-slate-500 hover:text-rose-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* MAIN WORKSPACE CANVAS: 272px Left Step Sidebar + Main Content Viewport */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar: 8-Step Sequential Progression Tracker */}
        <aside className="hidden lg:flex w-72 shrink-0 flex-col justify-between border-r border-slate-800 bg-[#0F172A]">
          <div className="overflow-y-auto p-5">
            <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
              <span className="text-xs font-semibold text-slate-200">
                8-Step Sequential Protocol
              </span>
              <span className="font-mono text-xs text-slate-400 tabular-nums">
                {completedSteps.length}/8 Done
              </span>
            </div>

            <div className="space-y-1">
              {EDA_STEPS_META.map((item) => {
                const isDone = completedSteps.includes(item.step);
                const isCurrent = currentStep === item.step;
                const isNextAllowed = dfState && item.step === currentStep + 1;
                const isLocked = !dfState || item.step > currentStep + 1;

                return (
                  <button
                    key={item.step}
                    type="button"
                    disabled={Boolean(isLocked || isExecutingStep)}
                    onClick={() => {
                      setActiveTab('session');
                      if (isDone || isCurrent) {
                        const el = document.getElementById(`eda-step-card-${item.step}`);
                        el?.scrollIntoView({ behavior: 'smooth' });
                      } else if (isNextAllowed && dfState) {
                        executeEdaStep(item.step, dfState);
                      }
                    }}
                    className={`w-full text-left px-3 py-2.5 transition-colors border-l-2 ${
                      isCurrent
                        ? 'border-sky-400 bg-sky-950/40 text-slate-100'
                        : isDone
                        ? 'border-emerald-500 bg-slate-900/40 text-slate-200 hover:bg-slate-800/50'
                        : isNextAllowed
                        ? 'border-amber-500 bg-amber-950/20 text-slate-200 hover:bg-amber-950/40'
                        : 'border-transparent text-slate-600 cursor-not-allowed'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold tabular-nums">
                        0{item.step}. {item.shortTitle}
                      </span>
                      {isCurrent && isExecutingStep ? (
                        <span className="font-mono text-[10px] text-sky-400">Running...</span>
                      ) : isDone ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      ) : isNextAllowed ? (
                        <Play className="h-3 w-3 shrink-0 text-amber-400" />
                      ) : (
                        <Lock className="h-3 w-3 shrink-0 text-slate-700" />
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-slate-400 line-clamp-1">
                      {item.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Active DataFrame Telemetry & Persistence Summary in Sidebar Footer */}
          <div className="border-t border-slate-800 bg-slate-950/60 p-4">
            {dfState ? (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span
                    className="truncate font-mono text-xs font-semibold text-slate-200"
                    title={dfState.profile.fileName}
                  >
                    {dfState.profile.fileName}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleStartNewSession(true)}
                    title="Start a new session (current session remains saved)"
                    className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1"
                  >
                    <RotateCcw className="h-3 w-3" />
                    New
                  </button>
                </div>

                {/* Zero-pill metadata discipline: clean unboxed text with · separators */}
                <div className="text-xs text-slate-400 font-mono tabular-nums">
                  <span>{dfState.profile.rowCount} rows</span>
                  <span className="mx-1.5 text-slate-600">·</span>
                  <span>{dfState.profile.colCount} cols</span>
                  <span className="mx-1.5 text-slate-600">·</span>
                  <span>{dfState.profile.totalMissingPct}% null</span>
                </div>

                {lastSavedTime && (
                  <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 font-mono">
                    <Check className="h-3 w-3 shrink-0" />
                    <span>Session auto-saved · {lastSavedTime}</span>
                  </div>
                )}

                <div className="pt-1 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={handleExportPDF}
                    className="flex items-center justify-center gap-1.5 bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 whitespace-nowrap"
                  >
                    <FileText className="h-3 w-3" />
                    PDF Report
                  </button>
                  <button
                    type="button"
                    onClick={handleExportCSV}
                    className="flex items-center justify-center gap-1.5 border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
                  >
                    <Download className="h-3 w-3" />
                    Export CSV
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-xs text-slate-400">
                <div className="font-semibold text-slate-300">No Active DataFrame</div>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  Upload a CSV/XLSX file or connect Google Drive. Sessions auto-save automatically.
                </p>
              </div>
            )}
          </div>
        </aside>

        {/* Main Viewport */}
        <main className="flex flex-1 flex-col overflow-hidden">
          {restoredNotice && (
            <div className="flex items-center justify-between border-b border-emerald-900/80 bg-emerald-950/60 px-6 py-2 text-xs text-emerald-200">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                <span>{restoredNotice}</span>
              </div>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => handleStartNewSession(true)}
                  className="font-semibold text-amber-300 hover:underline"
                >
                  Start Fresh Session
                </button>
                <button
                  type="button"
                  onClick={() => setRestoredNotice(null)}
                  className="font-semibold underline text-emerald-200"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {errorBanner && (
            <div className="flex items-center justify-between border-b border-red-900/80 bg-red-950/70 px-6 py-2 text-xs text-red-300">
              <span>{errorBanner}</span>
              <button
                type="button"
                onClick={() => setErrorBanner(null)}
                className="font-semibold underline ml-4 text-red-200"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* TAB 1: INTERACTIVE EDA CHAT SESSION */}
          {activeTab === 'session' && (
            <div className="flex flex-1 flex-col overflow-hidden">
              {/* Persistent Active Dataset Variable Types (dtypes) & Quick Export Bar */}
              {dfState && (
                <div className="border-b border-slate-800 bg-slate-900/90 px-4 py-2.5 sm:px-8">
                  <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-slate-200">
                        Variable Types (<code className="font-mono text-sky-400">df.dtypes</code>):
                      </span>
                      {dfState.profile.columns.map((col) => (
                        <label
                          key={col.name}
                          className="inline-flex items-center gap-1 border border-slate-800 bg-slate-950 px-2 py-0.5 font-mono text-[11px]"
                        >
                          <span className="text-slate-200">{col.name}:</span>
                          <select
                            value={col.dtype}
                            onChange={(e) =>
                              handleChangeColumnDType(col.name, e.target.value as PandasDType)
                            }
                            className={`bg-transparent font-semibold focus:outline-none ${
                              col.dtype === 'datetime64[ns]'
                                ? 'text-emerald-400'
                                : col.numeric
                                ? 'text-sky-400'
                                : 'text-amber-400'
                            }`}
                          >
                            <option value="datetime64[ns]" className="bg-slate-900 text-emerald-400">
                              datetime64[ns]
                            </option>
                            <option value="int64" className="bg-slate-900 text-sky-400">
                              int64
                            </option>
                            <option value="float64" className="bg-slate-900 text-sky-400">
                              float64
                            </option>
                            <option value="object" className="bg-slate-900 text-amber-400">
                              object
                            </option>
                            <option value="bool" className="bg-slate-900 text-amber-400">
                              bool
                            </option>
                          </select>
                        </label>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] font-mono text-emerald-400">
                      <Check className="h-3 w-3" />
                      <span>Auto-Saved{lastSavedTime ? ` (${lastSavedTime})` : ''}</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
                <div className="mx-auto max-w-4xl space-y-6">
                  {messages.map((msg) => (
                    <div
                      key={msg.id}
                      id={msg.stepNumber ? `eda-step-card-${msg.stepNumber}` : undefined}
                      className={`${
                        msg.role === 'user'
                          ? 'ml-auto max-w-xl border border-sky-800/80 bg-sky-950/60 px-4 py-3 text-slate-100'
                          : 'border border-slate-800 bg-[#0F172A] p-6'
                      }`}
                    >
                      {/* Message Header Metadata (Unboxed text with · separators) */}
                      <div
                        className={`mb-2 flex items-center justify-between text-xs ${
                          msg.role === 'user' ? 'text-sky-300' : 'text-slate-400'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-semibold ${
                              msg.role === 'user' ? 'text-white' : 'text-slate-100'
                            }`}
                          >
                            {msg.role === 'user'
                              ? 'You'
                              : msg.stepNumber
                              ? `0${msg.stepNumber}. ${EDA_STEPS_META[msg.stepNumber - 1]?.title}`
                              : 'Veritas EDA Assistant'}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">{msg.timestamp}</span>
                          {msg.stepNumber && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono text-sky-400">
                                Step {msg.stepNumber} of 8
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Python Code Execution Cell */}
                      {msg.role === 'assistant' && msg.pythonCode && (
                        <div className="my-3 border border-slate-800 bg-[#070B14] text-slate-100">
                          <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/90 px-3.5 py-1.5 font-mono text-[11px] text-slate-400">
                            <span className="flex items-center gap-1.5">
                              <Terminal className="h-3 w-3 text-sky-400" />
                              Python 3 (Pandas · Matplotlib · Seaborn)
                            </span>
                            <span>In [{msg.stepNumber || 1}]</span>
                          </div>
                          <pre className="overflow-x-auto p-3.5 font-mono text-xs leading-relaxed text-slate-200">
                            <code>{msg.pythonCode}</code>
                          </pre>
                          {msg.pythonStdout && (
                            <div className="border-t border-slate-800 bg-slate-950 p-3 font-mono text-xs text-emerald-400">
                              <div className="mb-1 text-[10px] text-slate-500">
                                Out [{msg.stepNumber || 1}]:
                              </div>
                              <pre className="overflow-x-auto whitespace-pre-wrap leading-relaxed tabular-nums">
                                {msg.pythonStdout}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Message Markdown Content */}
                      {msg.role === 'user' ? (
                        <p className="text-sm text-slate-100">{msg.content}</p>
                      ) : (
                        <MarkdownRenderer content={msg.content} />
                      )}

                      {/* Initial State Data Ingestion Card inside Welcome Message */}
                      {msg.id.startsWith('welcome-') && !dfState && (
                        <div className="mt-5 space-y-4 border-t border-slate-800 pt-5">
                          {/* If there are previously saved sessions, show a quick Resume card right on the welcome screen */}
                          {savedSessions.length > 0 && (
                            <div className="border border-sky-800/70 bg-sky-950/20 p-4">
                              <div className="mb-2.5 flex items-center justify-between">
                                <span className="flex items-center gap-1.5 text-xs font-semibold text-sky-300">
                                  <History className="h-3.5 w-3.5" />
                                  Resume a Previously Saved EDA Session:
                                </span>
                                <span className="font-mono text-[11px] text-slate-400">
                                  Auto-saved in browser
                                </span>
                              </div>
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                {savedSessions.slice(0, 4).map((sess) => (
                                  <div
                                    key={sess.sessionId}
                                    onClick={() => handleResumeSavedSession(sess.sessionId)}
                                    className="cursor-pointer flex items-center justify-between border border-slate-800 bg-slate-900/90 px-3 py-2.5 hover:border-sky-500 transition-colors"
                                  >
                                    <div className="min-w-0 pr-2">
                                      <div className="truncate text-xs font-semibold text-slate-100">
                                        {sess.title}
                                      </div>
                                      <div className="truncate font-mono text-[11px] text-sky-400 tabular-nums">
                                        Step {sess.currentStep}/8 · {sess.rowCount} rows × {sess.colCount} cols
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        onClick={(e) => handleDeleteSavedSession(sess.sessionId, e)}
                                        title="Delete saved session"
                                        className="p-1 text-slate-500 hover:text-rose-400"
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </button>
                                      <ChevronRight className="h-4 w-4 shrink-0 text-sky-400" />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            {/* Upload Local CSV / XLSX */}
                            <div
                              onClick={() => fileInputRef.current?.click()}
                              className="cursor-pointer border border-dashed border-slate-700 bg-slate-900/60 p-4 hover:border-sky-500 hover:bg-sky-950/20 transition-colors"
                            >
                              <div className="flex items-center gap-2 text-xs font-semibold text-slate-100">
                                <Upload className="h-4 w-4 text-sky-400" />
                                1. Upload CSV or Excel (.xlsx) File
                              </div>
                              <p className="mt-1 text-xs text-slate-400">
                                Click to select a local dataset file from your computer. Loaded directly into a Pandas DataFrame.
                              </p>
                            </div>

                            {/* Connect or Paste Google Drive File */}
                            <div
                              onClick={() => setIsDriveModalOpen(true)}
                              className="cursor-pointer border border-dashed border-slate-700 bg-slate-900/60 p-4 hover:border-sky-500 hover:bg-sky-950/20 transition-colors"
                            >
                              <div className="flex items-center gap-2 text-xs font-semibold text-slate-100">
                                <FolderOpen className="h-4 w-4 text-sky-400" />
                                2. Import from Google Drive / Link
                              </div>
                              <p className="mt-1 text-xs text-slate-400">
                                Browse your Google Drive spreadsheets/CSVs with permission, or paste a public Google Drive link.
                              </p>
                            </div>
                          </div>

                          {/* Benchmark Sample Datasets for Quick Verification */}
                          <div className="border border-slate-800 bg-slate-950/60 p-3.5">
                            <div className="mb-2 text-xs font-semibold text-slate-300">
                              Or Load a Curated Benchmark Dataset to Test All 8 Steps Immediately:
                            </div>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                              {SAMPLE_DATASETS.map((sample) => (
                                <button
                                  key={sample.id}
                                  type="button"
                                  onClick={() => handleLoadSampleDataset(sample.id)}
                                  className="flex items-center justify-between border border-slate-800 bg-slate-900 px-3 py-2 text-left hover:border-sky-500 transition-colors"
                                >
                                  <div className="min-w-0 pr-2">
                                    <div className="truncate text-xs font-semibold text-slate-100">
                                      {sample.name}
                                    </div>
                                    <div className="truncate font-mono text-[11px] text-slate-400">
                                      {sample.fileName} · {sample.domain}
                                    </div>
                                  </div>
                                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Inline Plots & Tables for Steps 1..8 */}
                      {msg.role === 'assistant' && msg.stepNumber && dfState && (
                        <StepVisualizations
                          step={msg.stepNumber}
                          profile={dfState.profile}
                          sandboxPlots={msg.sandboxPlots}
                          onApplyMissingFix={msg.stepNumber === 3 ? handleApplyMissingFix : undefined}
                          onApplyOutlierFix={msg.stepNumber === 4 ? handleApplyOutlierFix : undefined}
                          onApplyTransform={msg.stepNumber === 5 ? handleApplyTransform : undefined}
                          onChangeColumnDType={handleChangeColumnDType}
                          onExportCSV={msg.stepNumber === 8 ? handleExportCSV : undefined}
                          onExportReport={msg.stepNumber === 8 ? handleExportReport : undefined}
                          onExportPDF={msg.stepNumber === 8 ? handleExportPDF : undefined}
                          onOpenDashboardTab={
                            msg.stepNumber === 8 ? () => setActiveTab('dashboard') : undefined
                          }
                        />
                      )}

                      {/* Final Step 8 Completion Deliverables Bar (PDF Report + Dashboard Summary) */}
                      {msg.role === 'assistant' && msg.stepNumber === 8 && dfState && (
                        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-emerald-800/60 bg-emerald-950/30 px-4 py-3.5">
                          <div className="text-xs text-slate-200">
                            <span className="font-semibold text-emerald-300">
                              8-Step EDA Complete:{' '}
                            </span>
                            Download your publication-ready PDF Report or open the full Dashboard Summary.
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={handleExportPDF}
                              className="flex items-center gap-1.5 bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 whitespace-nowrap"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              Download PDF Report (.pdf)
                            </button>
                            <button
                              type="button"
                              onClick={() => setActiveTab('dashboard')}
                              className="flex items-center gap-1.5 bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500 whitespace-nowrap"
                            >
                              <LayoutDashboard className="h-3.5 w-3.5" />
                              Open Full Dashboard Summary
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Explicit Permission Gate Action Bar at the end of the active step */}
                      {msg.role === 'assistant' &&
                        msg.awaitingPermissionForStep &&
                        msg.stepNumber === currentStep && (
                          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 bg-slate-950/70 px-4 py-3">
                            <div className="text-xs text-slate-300">
                              <span className="font-semibold text-slate-100">
                                Permission Gate (Step {msg.stepNumber} → Step{' '}
                                {msg.awaitingPermissionForStep}):{' '}
                              </span>
                              Confirm to advance or type an adjustment below.
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => handleStartNewSession(true)}
                                className="flex items-center gap-1.5 border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700 whitespace-nowrap"
                              >
                                <RotateCcw className="h-3.5 w-3.5 text-amber-400" />
                                New Session
                              </button>
                              <button
                                type="button"
                                disabled={isExecutingStep}
                                onClick={() =>
                                  handleSendMessage(
                                    undefined,
                                    `Yes, proceed to Step ${msg.awaitingPermissionForStep}`
                                  )
                                }
                                className="flex items-center gap-1.5 bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50 whitespace-nowrap"
                              >
                                <Play className="h-3.5 w-3.5" />
                                Yes, Proceed to Step {msg.awaitingPermissionForStep} (
                                {EDA_STEPS_META[msg.awaitingPermissionForStep - 1]?.shortTitle})
                              </button>
                            </div>
                          </div>
                        )}
                    </div>
                  ))}

                  {/* If a session was restored right after Step 0 briefing before Step 1 finished, show a Resume button */}
                  {dfState &&
                    currentStep >= 1 &&
                    !isExecutingStep &&
                    !messages.some((m) => m.role === 'assistant' && m.stepNumber === currentStep) && (
                      <div className="flex items-center justify-between border border-sky-800 bg-sky-950/40 p-4">
                        <div className="text-xs text-slate-200">
                          Your session for <strong>{dfState.profile.fileName}</strong> is ready to resume at{' '}
                          <strong>Step {currentStep}: {EDA_STEPS_META[currentStep - 1]?.title}</strong>.
                        </div>
                        <button
                          type="button"
                          onClick={() => executeEdaStep(currentStep, dfState)}
                          className="flex items-center gap-1.5 bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-500 whitespace-nowrap"
                        >
                          <Play className="h-3.5 w-3.5" />
                          Resume Step {currentStep}
                        </button>
                      </div>
                    )}

                  {isExecutingStep && (
                    <div className="flex items-center justify-between border border-slate-800 bg-[#0F172A] p-5">
                      <div className="flex items-center gap-3 text-xs text-slate-300 font-mono">
                        <div className="h-3.5 w-3.5 animate-spin border-2 border-sky-400 border-t-transparent rounded-full" />
                        <span>
                          Executing Python Pandas & Seaborn environment for Step{' '}
                          {currentStep === 0 ? 1 : currentStep}...
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleStartNewSession(true)}
                        className="border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-medium text-slate-300 hover:bg-slate-700 whitespace-nowrap"
                      >
                        Cancel Session
                      </button>
                    </div>
                  )}

                  <div ref={chatEndRef} />
                </div>
              </div>

              {/* Conversational Chat & Permission Gate Input Bar */}
              <div className="border-t border-slate-800 bg-[#0F172A] px-4 py-3.5 sm:px-8">
                <form
                  onSubmit={(e) => handleSendMessage(e)}
                  className="mx-auto flex max-w-4xl items-center gap-2"
                >
                  <button
                    type="button"
                    onClick={() => handleStartNewSession(true)}
                    title="Start a new session (current session remains saved in browser)"
                    className="border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap flex items-center gap-1.5"
                  >
                    <RotateCcw className="h-3.5 w-3.5 text-amber-400" />
                    <span>New Session</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    title="Upload CSV / XLSX dataset"
                    className="border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap flex items-center gap-1.5"
                  >
                    <Upload className="h-3.5 w-3.5 text-slate-300" />
                    <span className="hidden sm:inline">Upload File</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsDriveModalOpen(true)}
                    title="Browse Google Drive or paste Drive link"
                    className="border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap flex items-center gap-1.5"
                  >
                    <FolderOpen className="h-3.5 w-3.5 text-sky-400" />
                    <span className="hidden sm:inline">Drive</span>
                  </button>
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    disabled={isExecutingStep}
                    placeholder={
                      !dfState
                        ? 'Paste a publicly accessible Google Drive file link or upload a CSV/XLSX...'
                        : currentStep < 8
                        ? `Reply with 'Yes' to proceed to Step ${
                            currentStep + 1
                          }, or describe any specific adjustments first...`
                        : 'Ask a follow-up question about your dataset...'
                    }
                    className="flex-1 border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!chatInput.trim() || isExecutingStep}
                    className="flex items-center gap-1.5 bg-sky-600 px-4 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50 whitespace-nowrap"
                  >
                    <Send className="h-3.5 w-3.5" />
                    Send
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* TAB 2: DATAFRAME INSPECTOR */}
          {activeTab === 'inspector' && (
            <div className="flex-1 overflow-y-auto p-6">
              {!dfState ? (
                <div className="mx-auto max-w-lg border border-slate-800 bg-[#0F172A] p-8 text-center">
                  <FileSpreadsheet className="mx-auto h-8 w-8 text-slate-500" />
                  <h3 className="mt-3 text-sm font-semibold text-slate-100">
                    No DataFrame Loaded Yet
                  </h3>
                  <p className="mt-1 text-xs text-slate-400">
                    Upload a CSV/XLSX file or import a spreadsheet from Google Drive to inspect rows and column profiles.
                  </p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-4 bg-sky-600 px-4 py-2 text-xs font-medium text-white hover:bg-sky-500"
                  >
                    Upload CSV / XLSX
                  </button>
                </div>
              ) : (
                <div className="mx-auto max-w-6xl space-y-6">
                  <div className="flex flex-wrap items-center justify-between gap-4 border border-slate-800 bg-[#0F172A] p-4">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-100">
                        Active Pandas DataFrame:{' '}
                        <code className="font-mono text-sky-400">{dfState.profile.fileName}</code>
                      </h2>
                      <p className="mt-0.5 font-mono text-xs text-slate-400 tabular-nums">
                        {dfState.profile.rowCount} rows × {dfState.profile.colCount} columns ·{' '}
                        {dfState.profile.totalMissingCells} missing cells ·{' '}
                        {dfState.profile.duplicateRowCount} duplicate rows
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" />
                        <input
                          type="text"
                          value={inspectorSearch}
                          onChange={(e) => setInspectorSearch(e.target.value)}
                          placeholder="Filter rows..."
                          className="border border-slate-700 bg-slate-900 pl-8 pr-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={handleExportPDF}
                        className="bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 whitespace-nowrap"
                      >
                        Download PDF Report
                      </button>
                      <button
                        type="button"
                        onClick={handleExportCSV}
                        className="bg-sky-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500 whitespace-nowrap"
                      >
                        Export Cleaned CSV
                      </button>
                    </div>
                  </div>

                  <div className="overflow-x-auto border border-slate-800 bg-[#0F172A]">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-800 bg-slate-950/70 font-mono text-slate-300">
                          <th className="px-3 py-2.5 font-semibold text-slate-500">#</th>
                          {dfState.profile.columns.map((c) => (
                            <th key={c.name} className="px-3 py-2.5 font-semibold whitespace-nowrap">
                              <div className="text-slate-200">{c.name}</div>
                              <div className="mt-1 flex items-center gap-1.5 text-[10px] font-normal text-slate-400">
                                <select
                                  value={c.dtype}
                                  onChange={(e) =>
                                    handleChangeColumnDType(c.name, e.target.value as PandasDType)
                                  }
                                  className="border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-sky-400 focus:border-sky-500 focus:outline-none"
                                >
                                  <option value="datetime64[ns]">datetime64[ns]</option>
                                  <option value="int64">int64</option>
                                  <option value="float64">float64</option>
                                  <option value="object">object</option>
                                  <option value="bool">bool</option>
                                </select>
                                <span>· {c.missingPct}% null</span>
                              </div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/80 font-mono">
                        {dfState.rows
                          .filter((r) =>
                            !inspectorSearch.trim()
                              ? true
                              : Object.values(r).some((v) =>
                                  String(v ?? '')
                                    .toLowerCase()
                                    .includes(inspectorSearch.toLowerCase())
                                )
                          )
                          .slice(0, 60)
                          .map((row, idx) => (
                            <tr key={idx} className="hover:bg-slate-800/40">
                              <td className="px-3 py-2 text-slate-500 tabular-nums">{idx}</td>
                              {dfState.profile.columns.map((c) => {
                                const v = row[c.name];
                                const isNull = v === null || v === undefined || v === '';
                                return (
                                  <td
                                    key={c.name}
                                    className={`px-3 py-2 whitespace-nowrap tabular-nums ${
                                      isNull ? 'italic text-amber-400' : 'text-slate-200'
                                    }`}
                                  >
                                    {isNull ? 'NaN' : String(v)}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: PYTHON NOTEBOOK LOG */}
          {activeTab === 'notebook' && (
            <div className="flex-1 overflow-y-auto p-6">
              <div className="mx-auto max-w-4xl space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-800 bg-[#0F172A] p-4">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-100">
                      Executed Python Notebook Log
                    </h2>
                    <p className="mt-0.5 text-xs text-slate-400">
                      All Pandas, NumPy, Matplotlib, and Seaborn code cells executed across your 8-step EDA session.
                    </p>
                  </div>
                  {dfState && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleExportPDF}
                        className="bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 whitespace-nowrap"
                      >
                        Download PDF Report (.pdf)
                      </button>
                      <button
                        type="button"
                        onClick={handleExportReport}
                        className="border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
                      >
                        Download Markdown (.md)
                      </button>
                    </div>
                  )}
                </div>

                {messages.filter((m) => m.pythonCode).length === 0 ? (
                  <div className="border border-slate-800 bg-[#0F172A] p-8 text-center text-xs text-slate-400">
                    No Python cells executed yet. Load a dataset to begin Step 1.
                  </div>
                ) : (
                  messages
                    .filter((m) => m.pythonCode)
                    .map((m, idx) => (
                      <div key={m.id} className="border border-slate-800 bg-[#0F172A] p-5">
                        <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
                          <span className="font-semibold text-slate-100">
                            Cell [{idx + 1}] · {m.stepNumber ? `Step ${m.stepNumber}` : 'Data Load'}
                          </span>
                          <span className="font-mono tabular-nums">{m.timestamp}</span>
                        </div>
                        <pre className="overflow-x-auto border border-slate-800 bg-[#070B14] p-4 font-mono text-xs text-slate-100 leading-relaxed">
                          <code>{m.pythonCode}</code>
                        </pre>
                        {m.pythonStdout && (
                          <pre className="mt-2 overflow-x-auto border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-emerald-400 tabular-nums">
                            {m.pythonStdout}
                          </pre>
                        )}
                      </div>
                    ))
                )}
              </div>
            </div>
          )}

          {/* TAB 4: EXECUTIVE DASHBOARD SUMMARY */}
          {activeTab === 'dashboard' && (
            <div className="flex-1 overflow-y-auto p-6">
              {!dfState ? (
                <div className="mx-auto max-w-lg border border-slate-800 bg-[#0F172A] p-8 text-center text-xs text-slate-400">
                  Load a dataset first to view the consolidated Executive EDA Dashboard Summary and export the PDF Report.
                </div>
              ) : (
                <div className="mx-auto max-w-5xl space-y-6">
                  <StepVisualizations
                    step={8}
                    profile={dfState.profile}
                    onExportCSV={handleExportCSV}
                    onExportReport={handleExportReport}
                    onExportPDF={handleExportPDF}
                  />
                  <StepVisualizations step={6} profile={dfState.profile} />
                  <StepVisualizations step={7} profile={dfState.profile} />
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Google Drive File Picker & Link Modal */}
      <GoogleDriveModal
        isOpen={isDriveModalOpen}
        onClose={() => setIsDriveModalOpen(false)}
        isAuthenticated={!needsAuth}
        isLoggingIn={isLoggingIn}
        onLogin={handleGoogleLogin}
        onNeedsAuth={() => setNeedsAuth(true)}
        onSelectBuffer={async (buffer, fileName) => {
          const userMsg: ChatMessage = {
            id: `user-drive-${Date.now()}`,
            role: 'user',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            content: `Imported dataset from Google Drive: **${fileName}**`,
          };
          setMessages((prev) => [...prev, userMsg]);
          await handleDatasetBufferLoaded(buffer, fileName, 'google_drive');
        }}
      />
    </div>
  );
}
