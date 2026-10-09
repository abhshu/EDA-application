import { DataFrameState } from '../utils/edaEngine';

export interface PersistedChatMessage {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  timestamp: string;
  stepNumber?: number;
  pythonCode?: string;
  pythonStdout?: string;
  sandboxPlots?: { mimeType: string; data: string }[];
  awaitingPermissionForStep?: number;
}

export interface SavedEdaSession {
  sessionId: string;
  title: string;
  fileName: string | null;
  createdAt: string;
  updatedAt: string;
  currentStep: number;
  completedSteps: number[];
  activeTab: 'session' | 'inspector' | 'notebook' | 'dashboard';
  dfState: DataFrameState | null;
  messages: PersistedChatMessage[];
}

export interface SavedSessionSummary {
  sessionId: string;
  title: string;
  fileName: string | null;
  updatedAt: string;
  currentStep: number;
  completedStepsCount: number;
  rowCount: number;
  colCount: number;
}

const DB_NAME = 'veritas_eda_studio_db';
const DB_VERSION = 1;
const STORE_NAME = 'eda_sessions';
const ACTIVE_SESSION_KEY = 'veritas_active_session_id';
const FALLBACK_STORAGE_KEY = 'veritas_fallback_active_session';

function openSessionDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB is not supported in this browser'));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
}

export function getActiveSessionId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_SESSION_KEY);
  } catch {
    return null;
  }
}

export function setActiveSessionId(sessionId: string): void {
  try {
    window.localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
  } catch {
    // Ignore storage quota / private mode warnings
  }
}

export async function saveEdaSession(session: SavedEdaSession): Promise<void> {
  setActiveSessionId(session.sessionId);

  // 1. Persist to backend server filesystem (.saved_sessions.json) so session survives iframe storage resets
  try {
    await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session }),
    });
  } catch (err) {
    console.warn('Server session sync warning:', err);
  }

  // 2. Also save a lightweight fallback copy in localStorage (up to 500 rows)
  try {
    const fallbackSession: SavedEdaSession = {
      ...session,
      dfState: session.dfState
        ? {
            ...session.dfState,
            rows: session.dfState.rows.slice(0, 500),
          }
        : null,
    };
    window.localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(fallbackSession));
  } catch {
    // Ignore localStorage quota exceeded for large datasets
  }

  // 3. Also save to browser IndexedDB
  try {
    const db = await openSessionDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(session);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch (err) {
    console.warn('IndexedDB save fallback used:', err);
  }
}

export async function loadEdaSessionById(sessionId: string): Promise<SavedEdaSession | null> {
  // 1. Try server-side persistent storage first
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (res.ok) {
      const data = await res.json();
      if (data?.session) {
        setActiveSessionId(sessionId);
        return data.session as SavedEdaSession;
      }
    }
  } catch {
    // Fallback to IndexedDB below
  }

  // 2. Try IndexedDB
  try {
    const db = await openSessionDb();
    const result = await new Promise<SavedEdaSession | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(sessionId);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as SavedEdaSession) || null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
    if (result) return result;
  } catch {
    // Fallback to localStorage below
  }

  // 3. Try localStorage
  try {
    const raw = window.localStorage.getItem(FALLBACK_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SavedEdaSession;
      if (parsed.sessionId === sessionId) {
        return parsed;
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

export async function loadMostRecentSession(): Promise<SavedEdaSession | null> {
  // 1. Check server-side persistent store first (survives iframe cookie/storage partitioning)
  try {
    const res = await fetch('/api/sessions');
    if (res.ok) {
      const data = await res.json();
      if (data?.activeSession && (data.activeSession.dfState || data.activeSession.messages?.length > 1)) {
        setActiveSessionId(data.activeSession.sessionId);
        return data.activeSession as SavedEdaSession;
      }
    }
  } catch {
    // Fallback to client storage
  }

  const activeId = getActiveSessionId();
  if (activeId) {
    const active = await loadEdaSessionById(activeId);
    if (active) return active;
  }

  try {
    const db = await openSessionDb();
    const allSessions = await new Promise<SavedEdaSession[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        db.close();
        resolve((req.result as SavedEdaSession[]) || []);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });

    if (allSessions.length > 0) {
      allSessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      const mostRecent = allSessions[0];
      setActiveSessionId(mostRecent.sessionId);
      // Sync to server so server has it too
      saveEdaSession(mostRecent).catch(() => {});
      return mostRecent;
    }
  } catch {
    // Fallback to localStorage
  }

  try {
    const raw = window.localStorage.getItem(FALLBACK_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SavedEdaSession;
      saveEdaSession(parsed).catch(() => {});
      return parsed;
    }
  } catch {
    // Ignore
  }

  return null;
}

export async function listSavedSessionSummaries(): Promise<SavedSessionSummary[]> {
  const summaryMap = new Map<string, SavedSessionSummary>();

  // 1. Fetch from server-side persistent storage
  try {
    const res = await fetch('/api/sessions');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.summaries)) {
        for (const s of data.summaries) {
          summaryMap.set(s.sessionId, s);
        }
      }
    }
  } catch {
    // Continue to client IndexedDB
  }

  // 2. Merge with browser IndexedDB sessions
  try {
    const db = await openSessionDb();
    const allSessions = await new Promise<SavedEdaSession[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        db.close();
        resolve((req.result as SavedEdaSession[]) || []);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });

    for (const s of allSessions) {
      if (s.dfState !== null || s.messages.length > 1) {
        summaryMap.set(s.sessionId, {
          sessionId: s.sessionId,
          title: s.title || s.fileName || 'Untitled EDA Session',
          fileName: s.fileName,
          updatedAt: s.updatedAt,
          currentStep: s.currentStep,
          completedStepsCount: s.completedSteps.length,
          rowCount: s.dfState?.profile.rowCount || 0,
          colCount: s.dfState?.profile.colCount || 0,
        });
      }
    }
  } catch {
    try {
      const raw = window.localStorage.getItem(FALLBACK_STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as SavedEdaSession;
        if (s.dfState) {
          summaryMap.set(s.sessionId, {
            sessionId: s.sessionId,
            title: s.title || s.fileName || 'Saved EDA Session',
            fileName: s.fileName,
            updatedAt: s.updatedAt,
            currentStep: s.currentStep,
            completedStepsCount: s.completedSteps.length,
            rowCount: s.dfState.profile.rowCount,
            colCount: s.dfState.profile.colCount,
          });
        }
      }
    } catch {
      // Ignore
    }
  }

  return Array.from(summaryMap.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function deleteSavedSession(sessionId: string): Promise<void> {
  try {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  } catch {
    // Ignore
  }

  try {
    const db = await openSessionDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(sessionId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    // Ignore
  }

  try {
    const raw = window.localStorage.getItem(FALLBACK_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SavedEdaSession;
      if (parsed.sessionId === sessionId) {
        window.localStorage.removeItem(FALLBACK_STORAGE_KEY);
      }
    }
  } catch {
    // Ignore
  }
}
