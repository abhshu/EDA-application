import React, { useEffect, useState } from 'react';
import { FolderOpen, Search, RefreshCw, X, FileSpreadsheet, KeyRound } from 'lucide-react';
import {
  DriveFileItem,
  listDriveDatasetFiles,
  downloadDriveFileContent,
  extractDriveFileId,
} from '../services/driveService';

interface GoogleSignInButtonProps {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}

export const GoogleSignInButton: React.FC<GoogleSignInButtonProps> = ({
  onClick,
  disabled,
  label = 'Sign in with Google',
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="gsi-material-button"
    >
      <div className="gsi-material-button-state"></div>
      <div className="gsi-material-button-content-wrapper">
        <div className="gsi-material-button-icon">
          <svg
            version="1.1"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 48 48"
            xmlnsXlink="http://www.w3.org/1999/xlink"
            style={{ display: 'block' }}
          >
            <path
              fill="#EA4335"
              d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
            ></path>
            <path
              fill="#4285F4"
              d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
            ></path>
            <path
              fill="#FBBC05"
              d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
            ></path>
            <path
              fill="#34A853"
              d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
            ></path>
            <path fill="none" d="M0 0h48v48H0z"></path>
          </svg>
        </div>
        <span className="gsi-material-button-contents">{label}</span>
        <span style={{ display: 'none' }}>{label}</span>
      </div>
    </button>
  );
};

interface GoogleDriveModalProps {
  isOpen: boolean;
  onClose: () => void;
  isAuthenticated: boolean;
  isLoggingIn: boolean;
  onLogin: (forceConsent?: boolean) => Promise<void>;
  onNeedsAuth: () => void;
  onSelectBuffer: (buffer: ArrayBuffer, fileName: string) => Promise<void>;
}

export const GoogleDriveModal: React.FC<GoogleDriveModalProps> = ({
  isOpen,
  onClose,
  isAuthenticated,
  isLoggingIn,
  onLogin,
  onNeedsAuth,
  onSelectBuffer,
}) => {
  const [files, setFiles] = useState<DriveFileItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyDatasets, setOnlyDatasets] = useState<boolean>(true);
  const [driveLinkInput, setDriveLinkInput] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchFiles = async (q?: string, datasetsFilter: boolean = onlyDatasets) => {
    if (!isAuthenticated) return;
    setLoadingList(true);
    setErrorMsg(null);
    try {
      let items = await listDriveDatasetFiles(q, datasetsFilter);
      // If no strict dataset files matched on initial load, automatically fall back to showing all Drive files
      if (items.length === 0 && datasetsFilter && (!q || !q.trim())) {
        const allItems = await listDriveDatasetFiles(q, false);
        if (allItems.length > 0) {
          setOnlyDatasets(false);
          items = allItems;
        }
      }
      setFiles(items);
    } catch (err: any) {
      if (err.code === 'NEEDS_AUTH' || err.message === 'NEEDS_AUTH') {
        onNeedsAuth();
        setErrorMsg(
          err.message && err.message !== 'NEEDS_AUTH'
            ? err.message
            : 'Please sign in with Google below to connect your Google Drive.'
        );
      } else {
        setErrorMsg(err.message || 'Unable to list Google Drive files.');
      }
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    if (isOpen && isAuthenticated) {
      fetchFiles(searchQuery, onlyDatasets);
    }
  }, [isOpen, isAuthenticated]);

  if (!isOpen) return null;

  const handleSelectFile = async (file: DriveFileItem) => {
    setDownloadingId(file.id);
    setErrorMsg(null);
    try {
      const { buffer, fileName } = await downloadDriveFileContent(
        file.id,
        file.mimeType,
        file.name,
        file.mimeType === 'application/vnd.google-apps.spreadsheet'
      );
      await onSelectBuffer(buffer, fileName);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to read file from Google Drive');
    } finally {
      setDownloadingId(null);
    }
  };

  const handleLoadFromLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!driveLinkInput.trim()) return;
    const { fileId, isSpreadsheetUrl } = extractDriveFileId(driveLinkInput);
    if (!fileId) {
      setErrorMsg(
        'Invalid Google Drive URL. Paste a valid link such as https://drive.google.com/file/d/FILE_ID/view or a Google Sheets link.'
      );
      return;
    }

    setDownloadingId(fileId);
    setErrorMsg(null);
    try {
      const { buffer, fileName } = await downloadDriveFileContent(
        fileId,
        undefined,
        undefined,
        isSpreadsheetUrl
      );
      await onSelectBuffer(buffer, fileName);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to load file from Google Drive link.');
    } finally {
      setDownloadingId(null);
    }
  };

  const handleToggleFilter = (datasetsOnly: boolean) => {
    setOnlyDatasets(datasetsOnly);
    fetchFiles(searchQuery, datasetsOnly);
  };

  // Client-side instant filter in addition to API search
  const displayedFiles = searchQuery.trim()
    ? files.filter((f) => f.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : files;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-2xl border border-slate-800 bg-[#0F172A] text-slate-100 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <FolderOpen className="h-4 w-4 text-sky-400" />
            <h3 className="text-sm font-semibold text-slate-100">
              Load Dataset from Google Drive
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-200"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Option 1: Paste a Google Drive / Google Sheets Link */}
          <div>
            <label className="block text-xs font-semibold text-slate-200 mb-1.5">
              Paste a Google Drive or Google Sheets Link
            </label>
            <form onSubmit={handleLoadFromLink} className="flex gap-2">
              <input
                type="text"
                value={driveLinkInput}
                onChange={(e) => setDriveLinkInput(e.target.value)}
                placeholder="https://drive.google.com/file/d/... or https://docs.google.com/spreadsheets/d/..."
                className="flex-1 border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!driveLinkInput.trim() || downloadingId !== null}
                className="bg-sky-600 px-4 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50 whitespace-nowrap"
              >
                {downloadingId ? 'Loading...' : 'Load Link'}
              </button>
            </form>
            <p className="mt-1 text-[11px] text-slate-400">
              Supports publicly shared CSV/XLSX links or private files when signed in with Google Drive.
            </p>
          </div>

          <div className="border-t border-slate-800 pt-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <span className="text-xs font-semibold text-slate-200">
                Browse Your Google Drive Datasets (CSV, XLSX, Google Sheets)
              </span>
              {isAuthenticated && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onLogin(true)}
                    className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
                    title="Re-authenticate or switch Google account"
                  >
                    <KeyRound className="h-3 w-3" />
                    Reconnect
                  </button>
                  <button
                    type="button"
                    onClick={() => fetchFiles(searchQuery, onlyDatasets)}
                    className="flex items-center gap-1 text-xs text-sky-400 hover:underline"
                  >
                    <RefreshCw className={`h-3 w-3 ${loadingList ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                </div>
              )}
            </div>

            {!isAuthenticated ? (
              <div className="flex flex-col items-center justify-center border border-slate-800 bg-slate-900/60 p-6 text-center">
                <p className="mb-3 max-w-md text-xs text-slate-300">
                  Sign in with your Google account (and check the Google Drive permission box if prompted) to browse and import CSV, Excel (.xlsx), or Google Sheets datasets directly from your Google Drive.
                </p>
                <GoogleSignInButton
                  onClick={() => onLogin(true)}
                  disabled={isLoggingIn}
                  label={isLoggingIn ? 'Signing in...' : 'Sign in with Google'}
                />
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          fetchFiles(searchQuery, onlyDatasets);
                        }
                      }}
                      placeholder="Filter Drive files by name..."
                      className="w-full border border-slate-700 bg-slate-900 pl-8 pr-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => fetchFiles(searchQuery, onlyDatasets)}
                    disabled={loadingList}
                    className="border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                  >
                    Search
                  </button>
                  <div className="flex items-center border border-slate-800 bg-slate-950 p-0.5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => handleToggleFilter(true)}
                      className={`px-2 py-1 transition-colors whitespace-nowrap ${
                        onlyDatasets ? 'bg-sky-600 text-white font-medium' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Datasets Only
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleFilter(false)}
                      className={`px-2 py-1 transition-colors whitespace-nowrap ${
                        !onlyDatasets ? 'bg-sky-600 text-white font-medium' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      All Files
                    </button>
                  </div>
                </div>

                <div className="max-h-64 overflow-y-auto border border-slate-800 bg-slate-950/60 divide-y divide-slate-800/80">
                  {loadingList ? (
                    <div className="p-6 text-center text-xs text-slate-400 font-mono">
                      Querying Google Drive API for files...
                    </div>
                  ) : displayedFiles.length === 0 ? (
                    <div className="p-6 text-center space-y-2">
                      <p className="text-xs text-slate-400">
                        {onlyDatasets
                          ? 'No CSV, XLSX, or Google Sheets files matched your filter.'
                          : 'No files found in your Google Drive matching your search.'}
                      </p>
                      {onlyDatasets && (
                        <button
                          type="button"
                          onClick={() => handleToggleFilter(false)}
                          className="text-xs font-medium text-sky-400 hover:underline"
                        >
                          Show all files in Google Drive
                        </button>
                      )}
                    </div>
                  ) : (
                    displayedFiles.map((f) => {
                      const isSheet = f.mimeType === 'application/vnd.google-apps.spreadsheet';
                      return (
                        <div
                          key={f.id}
                          className="flex items-center justify-between px-4 py-2.5 hover:bg-slate-800/50"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <FileSpreadsheet className="h-4 w-4 shrink-0 text-sky-400" />
                            <div className="min-w-0">
                              <div className="truncate text-xs font-medium text-slate-100">
                                {f.name}
                              </div>
                              <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                                {isSheet ? 'Google Sheet (auto-exports CSV)' : f.mimeType}
                                {f.modifiedTime
                                  ? ` · Modified ${new Date(f.modifiedTime).toLocaleDateString()}`
                                  : ''}
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={downloadingId !== null}
                            onClick={() => handleSelectFile(f)}
                            className="ml-3 shrink-0 bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                          >
                            {downloadingId === f.id ? 'Loading...' : 'Import'}
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {errorMsg && (
            <div className="border border-red-900/80 bg-red-950/60 px-4 py-2.5 text-xs text-red-300">
              {errorMsg}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
