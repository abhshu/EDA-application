import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
];

const provider = new GoogleAuthProvider();
SCOPES.forEach((scope) => provider.addScope(scope));

// Flag to indicate if we are in the middle of a sign-in flow.
let isSigningIn = false;
// Cache the access token in memory per Workspace Integration rules.
let cachedAccessToken: string | null = null;

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (forceConsent = false): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    if (forceConsent) {
      provider.setCustomParameters({ prompt: 'consent' });
    } else {
      provider.setCustomParameters({});
    }
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain Google Drive access token from Google Sign-In.');
    }

    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Sign in error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const logout = async () => {
  await auth.signOut();
  cachedAccessToken = null;
};

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
}

export function isDatasetFile(file: DriveFileItem): boolean {
  const name = (file.name || '').toLowerCase();
  const mime = (file.mimeType || '').toLowerCase();

  if (
    mime === 'text/csv' ||
    mime === 'application/csv' ||
    mime === 'text/tab-separated-values' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.google-apps.spreadsheet'
  ) {
    return true;
  }

  if (
    name.endsWith('.csv') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls') ||
    name.endsWith('.tsv')
  ) {
    return true;
  }

  return false;
}

export const listDriveDatasetFiles = async (
  searchQuery?: string,
  onlyDatasets: boolean = true
): Promise<DriveFileItem[]> => {
  const token = await getAccessToken();
  if (!token) {
    const err = new Error('Your Google Drive session needs to be connected. Please sign in with Google.');
    (err as any).code = 'NEEDS_AUTH';
    throw err;
  }

  // Keep the Drive v3 query simple and fast to avoid Drive API 400 errors when combining `contains` and `orderBy`.
  let q = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
  if (searchQuery && searchQuery.trim()) {
    const safeSearch = searchQuery.trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    q += ` and name contains '${safeSearch}'`;
  }

  const params = new URLSearchParams({
    q,
    pageSize: '100',
    fields: 'files(id, name, mimeType, modifiedTime, size)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });

  // Only include orderBy when there is no `name contains` clause, as Drive API can reject orderBy + contains
  if (!searchQuery || !searchQuery.trim()) {
    params.set('orderBy', 'modifiedTime desc');
  }

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401 || res.status === 403) {
    const errData = await res.json().catch(() => ({}));
    const apiMsg = errData?.error?.message || '';
    cachedAccessToken = null;
    const err = new Error(
      apiMsg
        ? `Google Drive access error: ${apiMsg}. Please click "Sign in with Google" and grant Google Drive permission.`
        : 'Google Drive session expired or permission was not granted. Please sign in with Google again.'
    );
    (err as any).code = 'NEEDS_AUTH';
    throw err;
  }

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `Failed to list Google Drive files (HTTP ${res.status})`);
  }

  const data = await res.json();
  let files: DriveFileItem[] = data.files || [];

  // If searchQuery was provided, also allow substring matching if Drive's token-prefix `name contains` returned nothing
  if (searchQuery && searchQuery.trim() && files.length === 0) {
    const fallbackParams = new URLSearchParams({
      q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
      pageSize: '100',
      orderBy: 'modifiedTime desc',
      fields: 'files(id, name, mimeType, modifiedTime, size)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    const fallbackRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?${fallbackParams.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (fallbackRes.ok) {
      const fallbackData = await fallbackRes.json();
      const needle = searchQuery.trim().toLowerCase();
      files = (fallbackData.files || []).filter((f: DriveFileItem) =>
        f.name.toLowerCase().includes(needle)
      );
    }
  }

  if (onlyDatasets) {
    const datasetFiles = files.filter(isDatasetFile);
    return datasetFiles;
  }

  return files;
};

export const extractDriveFileId = (input: string): { fileId: string | null; isSpreadsheetUrl: boolean } => {
  const trimmed = input.trim();
  const isSpreadsheetUrl = trimmed.includes('docs.google.com/spreadsheets');

  // Pattern 1: /file/d/<ID> or /spreadsheets/d/<ID>
  const dMatch = trimmed.match(/\/(?:file|spreadsheets)\/d\/([a-zA-Z0-9_-]{15,})/);
  if (dMatch) {
    return { fileId: dMatch[1], isSpreadsheetUrl };
  }

  // Pattern 2: ?id=<ID> or &id=<ID>
  const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{15,})/);
  if (idParamMatch) {
    return { fileId: idParamMatch[1], isSpreadsheetUrl };
  }

  // Pattern 3: Raw file ID
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) {
    return { fileId: trimmed, isSpreadsheetUrl: false };
  }

  return { fileId: null, isSpreadsheetUrl: false };
};

export const downloadDriveFileContent = async (
  fileId: string,
  knownMimeType?: string,
  knownFileName?: string,
  isSpreadsheetHint?: boolean
): Promise<{ buffer: ArrayBuffer; fileName: string; mimeType: string }> => {
  const token = await getAccessToken();

  // If authenticated with Google Drive OAuth, use the official Drive v3 API directly
  if (token) {
    let mimeType = knownMimeType || '';
    let fileName = knownFileName || `drive_dataset_${fileId.slice(0, 6)}.csv`;

    if (!knownMimeType || !knownFileName) {
      const metaRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType&supportsAllDrives=true`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (metaRes.ok) {
        const meta = await metaRes.json();
        mimeType = meta.mimeType || mimeType;
        fileName = meta.name || fileName;
      }
    }

    const isGoogleSheet =
      mimeType === 'application/vnd.google-apps.spreadsheet' || isSpreadsheetHint;

    const downloadUrl = isGoogleSheet
      ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`
      : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;

    const contentRes = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (contentRes.ok) {
      const buffer = await contentRes.arrayBuffer();
      if (isGoogleSheet && !fileName.toLowerCase().endsWith('.csv')) {
        fileName = `${fileName}.csv`;
      }
      return {
        buffer,
        fileName,
        mimeType: isGoogleSheet ? 'text/csv' : mimeType || 'text/csv',
      };
    }
  }

  // Fallback for publicly shared Google Drive / Google Sheets links via backend proxy
  const proxyRes = await fetch('/api/drive/public-fetch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      fileId,
      isSpreadsheet: isSpreadsheetHint || knownMimeType === 'application/vnd.google-apps.spreadsheet',
    }),
  });

  if (!proxyRes.ok) {
    const err = await proxyRes.json().catch(() => ({}));
    throw new Error(
      err.error ||
        'Could not fetch the Google Drive file. Please sign in with Google or ensure the file link is publicly shared ("Anyone with the link").'
    );
  }

  const fileNameHeader = proxyRes.headers.get('X-File-Name') || knownFileName || `drive_${fileId.slice(0, 8)}.csv`;
  const contentType = proxyRes.headers.get('Content-Type') || 'text/csv';
  const buffer = await proxyRes.arrayBuffer();

  return {
    buffer,
    fileName: fileNameHeader,
    mimeType: contentType,
  };
};
