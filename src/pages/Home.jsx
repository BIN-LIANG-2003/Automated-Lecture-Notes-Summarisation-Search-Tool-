import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import OcrResultModal from '../components/OcrResultModal.jsx';
import SendNoteByEmailModal from '../components/SendNoteByEmailModal.jsx';
import FeedbackWidget from '../components/FeedbackWidget.jsx';
import FriendsMessagesWidget from '../components/FriendsMessagesWidget.jsx';
import SummaryResultModal from '../components/SummaryResultModal.jsx';
import SummaryCenterModal from '../components/SummaryCenterModal.jsx';
import TrashModal from '../components/TrashModal.jsx';
import UploadPanel from '../components/UploadPanel.jsx';
import WorkspaceIcon, { isWorkspaceImageIcon } from '../components/WorkspaceIcon.jsx';
import WorkspaceSidebar from '../components/WorkspaceSidebar.jsx';
import useDocumentsList from '../hooks/useDocumentsList.js';
import useUploadQueue from '../hooks/useUploadQueue.js';
import { formatDateTimeLabel, todayKey } from '../lib/dates.js';
import { copyTextToClipboard } from '../lib/clipboard.js';
import { loadUsageMap, persistUsageMap } from '../lib/usage.js';
import { loadAccounts } from '../lib/accounts.js';
import {
  loadAccountHistory,
  persistAccountHistory,
  saveAccountToHistory,
  removeAccountFromHistory,
} from '../lib/accountHistory.js';
import {
  clearStoredAuthSession,
  getRememberAuthPreference,
  isCookieAuthToken,
  logoutCurrentSession,
  readStoredAuthSession,
  storeAuthSession,
} from '../lib/authSession.js';
import { authFetch } from '../lib/authFetch.js';
import {
  createWorkspace,
  loadWorkspaceState,
  persistWorkspaceState,
} from '../lib/workspaces.js';
import { downloadFileWithAuth } from '../lib/fileDownload.js';
import { coerceOcrText, formatOcrErrorMessage } from '../lib/ocr.js';
import {
  createDocumentShareLink,
  deleteDocumentShareLink,
  deleteInactiveDocumentShareLinks,
  deleteInactiveWorkspaceShareLinks,
  isActiveShareLink,
  listDocumentShareLinks,
  listWorkspaceShareLinks,
  revokeAllDocumentShareLinks,
  revokeAllWorkspaceShareLinks,
  revokeDocumentShareLink,
  sendDocumentShareLinkEmail,
} from '../lib/shareLinks.js';
import {
  buildSummaryExportFilename,
  buildSummaryExportText,
  downloadSummaryPdf,
  downloadTextFile,
  openSummaryEmailDraft,
} from '../lib/summaryExport.js';
import { formatSummaryErrorMessage } from '../lib/summaryDiagnostics.js';

const DEFAULT_SIDEBAR_RECENT_LIMIT = 10;
const MIN_SIDEBAR_RECENT_LIMIT = 5;
const MAX_SIDEBAR_RECENT_LIMIT = 20;
const DEFAULT_DOCUMENTS_PAGE_SIZE = 20;
const DOCUMENTS_PAGE_SIZE_OPTIONS = [12, 20, 40];
const DEFAULT_DOCUMENTS_SORT = 'newest';
const DEFAULT_DOCUMENTS_LAYOUT = 'grid';
const WORKSPACE_INVITE_REFRESH_MS = 5000;
const DOCUMENTS_LAYOUT_OPTIONS = [
  { value: 'grid', label: 'Grid' },
  { value: 'compact', label: 'Compact' },
];
const PROCESSING_STATUS_META = {
  queued: {
    label: 'Queued',
    message: 'PDF text is not ready yet. Run the optional document worker or retry upload.',
    summarizeTitle: 'PDF text is not ready. Run the optional worker or upload a text-selectable PDF.',
  },
  processing: {
    label: 'Processing',
    message: 'PDF text extraction is running in the document worker.',
    summarizeTitle: 'PDF text extraction is running in the document worker.',
  },
  text_pending: {
    label: 'Finalizing',
    message: 'PDF text was extracted in the browser but has not been saved yet. Retry upload if this does not clear.',
    summarizeTitle: 'PDF text is still being saved from the upload flow.',
  },
  needs_ocr: {
    label: 'OCR Needed',
    message: 'No selectable PDF text was found. OCR or a text-selectable PDF is required before summaries.',
    summarizeTitle: 'This PDF needs OCR or selectable text before summaries are available.',
  },
  no_text_available: {
    label: 'OCR Needed',
    message: 'No selectable PDF text was found. OCR or a text-selectable PDF is required before summaries.',
    summarizeTitle: 'This PDF needs OCR or selectable text before summaries are available.',
  },
  action_required: {
    label: 'Action Required',
    message: 'No selectable PDF text was found. OCR or a text-selectable PDF is required before summaries.',
    summarizeTitle: 'This PDF needs OCR or selectable text before summaries are available.',
  },
  failed: {
    label: 'Failed',
    message: 'PDF text extraction failed.',
    summarizeTitle: 'PDF text extraction failed. Upload a text-selectable PDF or run OCR.',
  },
};
const DOCUMENTS_SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'title_asc', label: 'Title A-Z' },
  { value: 'title_desc', label: 'Title Z-A' },
];
const TRASH_PAGE_SIZE_OPTIONS = [10, 20, 50];
const TRASH_SORT_OPTIONS = [
  { value: 'deleted_newest', label: 'Recently deleted' },
  { value: 'deleted_oldest', label: 'Oldest deleted' },
  { value: 'title_asc', label: 'Title A-Z' },
  { value: 'title_desc', label: 'Title Z-A' },
];
const MAX_SAVED_ACCOUNTS = 8;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_NOTE_CATEGORY = 'Uncategorized';
const SUGGESTED_CATEGORIES = [
  'Computer Science',
  'Mathematics',
  'Physics',
  'Chemistry',
  'Biology',
  'Economics',
  'Business',
  'Language',
  'General',
];
const SUMMARY_LENGTH_OPTIONS = ['short', 'medium', 'long'];
const LINK_SHARING_MODES = ['restricted', 'workspace', 'public'];
const getLinkSharingModeLabel = (mode) => {
  const safeMode = String(mode || '').trim().toLowerCase();
  if (safeMode === 'public') return 'Anyone With Link';
  if (safeMode === 'workspace') return 'Workspace Members';
  if (safeMode === 'restricted') return 'Restricted';
  return 'Workspace Members';
};
const extractWorkspaceIdFromNotification = (notification = {}) => {
  const metadata = notification?.metadata && typeof notification.metadata === 'object'
    ? notification.metadata
    : {};
  const metadataWorkspaceId = String(metadata.workspace_id || metadata.workspaceId || '').trim();
  if (metadataWorkspaceId) return metadataWorkspaceId;

  const linkUrl = String(notification?.link_url || '').trim();
  const match = linkUrl.match(/[?&](workspace_id|workspaceId)=([^&#]+)/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[2]).trim();
  } catch {
    return String(match[2] || '').trim();
  }
};
const extractSharedTokenFromNotification = (notification = {}) => {
  const metadata = notification?.metadata && typeof notification.metadata === 'object'
    ? notification.metadata
    : {};
  const metadataToken = String(metadata.share_token || metadata.shareToken || '').trim();
  if (metadataToken) return metadataToken;

  const linkUrl = String(notification?.link_url || '').trim();
  if (!linkUrl) return '';

  const extractFromPath = (value) => {
    const match = String(value || '').match(/\/shared\/([^/?#]+)/);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]).trim();
    } catch {
      return String(match[1] || '').trim();
    }
  };

  try {
    const url = new URL(linkUrl, window.location.origin);
    return extractFromPath(url.hash ? url.hash.slice(1) : url.pathname);
  } catch {
    return extractFromPath(linkUrl);
  }
};
const shouldOpenWorkspaceAccessPanel = (notification = {}) => {
  const metadata = notification?.metadata && typeof notification.metadata === 'object'
    ? notification.metadata
    : {};
  const requestedPanel = String(metadata.open || metadata.panel || '').trim().toLowerCase();
  const title = String(notification?.title || '').trim().toLowerCase();
  const linkUrl = String(notification?.link_url || '').trim().toLowerCase();
  return (
    requestedPanel === 'invite-members' ||
    requestedPanel === 'workspace-access' ||
    linkUrl.includes('open=invite-members') ||
    title.includes('workspace request received') ||
    title.includes('workspace member joined')
  );
};
const HOME_TAB_OPTIONS = ['home', 'files'];
const SIDEBAR_DENSITY_OPTIONS = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];
const DEFAULT_WORKSPACE_ACCENT_COLOR = '#2f76e8';
const WORKSPACE_ACCENT_PRESETS = [
  { value: '#2f76e8', label: 'Ocean' },
  { value: '#0f9d7a', label: 'Mint' },
  { value: '#e16a3d', label: 'Sunset' },
  { value: '#7a56d8', label: 'Iris' },
  { value: '#d1498b', label: 'Rose' },
  { value: '#2f3b52', label: 'Slate' },
];
const SUMMARY_CENTER_SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'title_asc', label: 'Title A-Z' },
];
const SUMMARY_CENTER_SOURCE_OPTIONS = [
  { value: 'all', label: 'All sources' },
  { value: 'cache', label: 'Cache hit' },
  { value: 'huggingface', label: 'HuggingFace' },
  { value: 'fallback', label: 'Fallback' },
];
const SUMMARY_CENTER_CHUNK_OPTIONS = [
  { value: 'all', label: 'All chunks' },
  { value: 'single', label: '1 chunk' },
  { value: 'multi', label: '2+ chunks' },
  { value: 'heavy', label: '5+ chunks' },
];
const WORKSPACE_SETTINGS_TABS = [
  { id: 'general', label: 'General', description: 'Name, icon, accent color, workspace identity.' },
  { id: 'experience', label: 'Experience', description: 'Sidebar density and overview widgets.' },
  { id: 'notifications', label: 'Notifications', description: 'Control in-app toasts and your email reminders.' },
  { id: 'permissions', label: 'Permissions', description: 'What members can upload, edit, and export.' },
  { id: 'ai', label: 'AI', description: 'Summary length and keyword defaults.' },
  { id: 'danger', label: 'Danger', description: 'Irreversible workspace cleanup actions.' },
];
const DEFAULT_USER_NOTIFICATION_PREFERENCES = {
  emailNotificationsEnabled: true,
};
const DEFAULT_WORKSPACE_SETTINGS = {
  workspace_icon: '📚',
  description: '',
  accent_color: DEFAULT_WORKSPACE_ACCENT_COLOR,
  default_category: DEFAULT_NOTE_CATEGORY,
  auto_categorize: true,
  default_home_tab: 'home',
  default_documents_layout: DEFAULT_DOCUMENTS_LAYOUT,
  default_documents_sort: DEFAULT_DOCUMENTS_SORT,
  default_documents_page_size: DEFAULT_DOCUMENTS_PAGE_SIZE,
  recent_items_limit: DEFAULT_SIDEBAR_RECENT_LIMIT,
  sidebar_density: 'comfortable',
  show_starred_section: true,
  show_recent_section: true,
  show_quick_actions: true,
  show_usage_chart: true,
  show_recent_activity: true,
  allow_uploads: true,
  allow_note_editing: true,
  allow_ai_tools: true,
  allow_ocr: true,
  summary_length: 'medium',
  keyword_limit: 5,
  notify_upload_events: true,
  notify_summary_events: true,
  notify_sharing_events: true,
  allow_member_invites: false,
  default_invite_expiry_days: 7,
  default_share_expiry_days: 7,
  link_sharing_mode: 'workspace',
  restrict_invites_to_domains: false,
  allowed_email_domains: '',
  block_invites_from_domains: false,
  blocked_email_domains: '',
  allow_member_share_management: false,
  max_active_share_links_per_document: 5,
  auto_revoke_previous_share_links: false,
  allow_export: true,
};
const DEFAULT_SUMMARY_PROGRESS = {
  active: false,
  token: '',
  phase: 'idle',
  forceRefresh: false,
  docId: 0,
  docTitle: '',
};

const DEFAULT_BULK_RESULT_SUMMARY = null;
const DEFAULT_TOAST_STATE = { open: false, message: '', tone: 'info' };
const DEFAULT_CONFIRM_DIALOG_STATE = {
  open: false,
  title: '',
  description: '',
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  danger: false,
};
const DEFAULT_INPUT_DIALOG_STATE = {
  open: false,
  title: '',
  description: '',
  placeholder: '',
  initialValue: '',
  confirmLabel: 'Save',
  cancelLabel: 'Cancel',
  danger: false,
  required: false,
  trimResult: false,
};
const BULK_SELECT_BATCH_SIZE = 120;
const BULK_SELECT_MAX_ITEMS = 600;

const FILES_VIEW_PREFS_KEY = 'studyhub-files-view-prefs-v1';
const SAVED_VIEWS_STORE_KEY = 'studyhub-saved-views-v1';
const STARRED_NOTES_STORE_KEY = 'studyhub-starred-notes-v1';
const RECENT_NOTES_STORE_KEY = 'studyhub-recent-notes-v1';
const SIDEBAR_COLLAPSED_STORE_KEY = 'studyhub-sidebar-collapsed-v1';
const SUMMARY_HISTORY_STORE_KEY = 'studyhub-summary-history-v1';
const MAX_SAVED_VIEWS_PER_WORKSPACE = 10;
const MAX_STARRED_NOTES_PER_WORKSPACE = 60;
const MAX_RECENT_NOTES_PER_WORKSPACE = 80;
const MAX_SUMMARY_HISTORY_PER_WORKSPACE = 60;
const TRASH_FETCH_LIMIT = 200;
const DEFAULT_FILTERS = { query: '', start: '', end: '', tag: '', category: '', fileType: '' };
const FILTER_DATE_RANGE_OPTIONS = [
  { id: 'today', label: 'Today', daysBack: 0 },
  { id: '7d', label: 'Last 7 Days', daysBack: 6 },
  { id: '30d', label: 'Last 30 Days', daysBack: 29 },
  { id: 'all', label: 'All Time', daysBack: null },
];
const FILE_TYPE_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'DOCX' },
  { value: 'txt', label: 'TXT' },
  { value: 'image', label: 'Images' },
];
const FILE_TYPE_FILTER_VALUES = new Set(FILE_TYPE_FILTER_OPTIONS.map((option) => option.value));
const IMAGE_FILE_TYPE_VALUES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

const createClientId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const createSavedViewId = () => createClientId('view');
const stripFileExtension = (value) => String(value || '').replace(/\.[a-z0-9]+$/i, '').trim();
const buildOcrNoteTitle = (value) => {
  const base = stripFileExtension(value) || 'Image';
  return `${base} OCR Note`;
};
const toPositiveDocId = (value) => {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return 0;
  return Math.floor(next);
};

const normalizeSummarySource = (value) => {
  const next = String(value || '').trim().toLowerCase();
  return next || 'fallback';
};

const normalizeSummaryCenterSort = (value) => {
  const next = String(value || '').trim().toLowerCase();
  return SUMMARY_CENTER_SORT_OPTIONS.some((item) => item.value === next) ? next : 'newest';
};

const normalizeSummaryCenterSource = (value) => {
  const next = String(value || '').trim().toLowerCase();
  return SUMMARY_CENTER_SOURCE_OPTIONS.some((item) => item.value === next) ? next : 'all';
};

const normalizeSummaryCenterChunkFilter = (value) => {
  const next = String(value || '').trim().toLowerCase();
  return SUMMARY_CENTER_CHUNK_OPTIONS.some((item) => item.value === next) ? next : 'all';
};

const normalizeFileTypeFilter = (value) => {
  const next = String(value || '').trim().toLowerCase();
  return FILE_TYPE_FILTER_VALUES.has(next) ? next : '';
};

const getFileTypeFilterLabel = (value) => {
  const normalized = normalizeFileTypeFilter(value);
  return FILE_TYPE_FILTER_OPTIONS.find((option) => option.value === normalized)?.label || 'All';
};

const normalizeFacetFileTypeCounts = (raw) => {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const counts = {};
  Object.entries(source).forEach(([key, value]) => {
    const safeKey = String(key || '').trim().toLowerCase();
    if (!safeKey) return;
    const safeCount = Math.max(0, Number(value) || 0);
    if (!safeCount) return;
    counts[safeKey] = safeCount;
  });

  if (!counts.image) {
    counts.image =
      (counts.png || 0) +
      (counts.jpg || 0) +
      (counts.jpeg || 0) +
      (counts.webp || 0) +
      (counts.gif || 0);
  }
  return counts;
};

const normalizeDocumentsPageSize = (value) => {
  const next = Number(value) || DEFAULT_DOCUMENTS_PAGE_SIZE;
  if (DOCUMENTS_PAGE_SIZE_OPTIONS.includes(next)) return next;
  return DEFAULT_DOCUMENTS_PAGE_SIZE;
};

const normalizeDocumentsSort = (value) => {
  const next = String(value || '').trim().toLowerCase();
  if (DOCUMENTS_SORT_OPTIONS.some((item) => item.value === next)) return next;
  return DEFAULT_DOCUMENTS_SORT;
};

const normalizeDocumentsLayout = (value) => {
  const next = String(value || '').trim().toLowerCase();
  return DOCUMENTS_LAYOUT_OPTIONS.some((item) => item.value === next)
    ? next
    : DEFAULT_DOCUMENTS_LAYOUT;
};

const normalizeTrashPageSize = (value) => {
  const next = Number(value) || TRASH_PAGE_SIZE_OPTIONS[1];
  if (TRASH_PAGE_SIZE_OPTIONS.includes(next)) return next;
  return TRASH_PAGE_SIZE_OPTIONS[1];
};

const normalizeTrashSort = (value) => {
  const next = String(value || '').trim().toLowerCase();
  if (TRASH_SORT_OPTIONS.some((item) => item.value === next)) return next;
  return 'deleted_newest';
};

const normalizeDomainInput = (value) => {
  let next = String(value || '').trim();
  if (!next) return '';
  if (next.startsWith('http://') || next.startsWith('https://')) {
    next = next.split('://', 1)[1] || '';
  }
  next = next.split('/', 1)[0].trim().toLowerCase();
  if (!next) return '';
  if (!next.includes('.')) return '';
  if (!/^[a-z0-9.-]{3,255}$/.test(next)) return '';
  return next;
};

const normalizeAccentColor = (value) => {
  const next = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(next) ? next : DEFAULT_WORKSPACE_ACCENT_COLOR;
};

const normalizeSidebarDensity = (value) => {
  const next = String(value || '').trim().toLowerCase();
  return SIDEBAR_DENSITY_OPTIONS.some((item) => item.value === next) ? next : 'comfortable';
};

const normalizeWorkspaceDomainToken = (value) => {
  const raw = String(value || '').trim().replace(/^@+/, '');
  if (!raw) return '';
  const next = normalizeDomainInput(raw);
  return next || '';
};

const normalizeWorkspaceDomainList = (value) => {
  const candidates = Array.isArray(value) ? value : String(value || '').split(/[\n,;]+/);
  const seen = new Set();
  const output = [];
  candidates.forEach((item) => {
    const domain = normalizeWorkspaceDomainToken(item);
    if (!domain || seen.has(domain)) return;
    seen.add(domain);
    output.push(domain);
  });
  return output.slice(0, 8).join(', ');
};

const parseWorkspaceDomainList = (value) =>
  normalizeWorkspaceDomainList(value)
    .split(/,\s*/)
    .map((item) => item.trim())
    .filter(Boolean);

const getEmailDomain = (email) => {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized.includes('@')) return '';
  return normalized.split('@').slice(1).join('@');
};

const clampRgbChannel = (value) => Math.min(255, Math.max(0, Math.round(value)));

const hexToRgb = (value) => {
  const safe = normalizeAccentColor(value).slice(1);
  return {
    r: Number.parseInt(safe.slice(0, 2), 16),
    g: Number.parseInt(safe.slice(2, 4), 16),
    b: Number.parseInt(safe.slice(4, 6), 16),
  };
};

const shiftHexColor = (value, amount) => {
  const { r, g, b } = hexToRgb(value);
  const delta = Number(amount) || 0;
  const toHex = (channel) => clampRgbChannel(channel + delta).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

const rgbaFromHex = (value, alpha = 1) => {
  const { r, g, b } = hexToRgb(value);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const buildWorkspaceThemeStyle = (settings) => {
  const accent = normalizeAccentColor(settings?.accent_color);
  return {
    '--primary': accent,
    '--primary-600': shiftHexColor(accent, -18),
    '--workspace-accent': accent,
    '--workspace-accent-strong': shiftHexColor(accent, -32),
    '--workspace-accent-soft': rgbaFromHex(accent, 0.12),
    '--workspace-accent-faint': rgbaFromHex(accent, 0.08),
    '--workspace-accent-border': rgbaFromHex(accent, 0.24),
  };
};

const toDateInputValue = (date) => {
  const safe = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(safe.getTime())) return '';
  const year = String(safe.getFullYear());
  const month = String(safe.getMonth() + 1).padStart(2, '0');
  const day = String(safe.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getQuickDateRange = (daysBack) => {
  if (!Number.isFinite(daysBack) || Number(daysBack) < 0) {
    return { start: '', end: '' };
  }
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setHours(12, 0, 0, 0);
  endDate.setHours(12, 0, 0, 0);
  startDate.setDate(startDate.getDate() - Number(daysBack));
  return {
    start: toDateInputValue(startDate),
    end: toDateInputValue(endDate),
  };
};

const formatDisplayDateValue = (value) => {
  if (!value) return 'YYYY/MM/DD';
  const [year, month, day] = String(value || '').split('-');
  return [year, month, day].filter(Boolean).join('/');
};

const loadFilesViewPreferences = () => {
  if (typeof window === 'undefined') {
    return {
      pageSize: DEFAULT_DOCUMENTS_PAGE_SIZE,
      sort: DEFAULT_DOCUMENTS_SORT,
      layout: DEFAULT_DOCUMENTS_LAYOUT,
    };
  }
  try {
    const raw = localStorage.getItem(FILES_VIEW_PREFS_KEY);
    if (!raw) {
      return {
        pageSize: DEFAULT_DOCUMENTS_PAGE_SIZE,
        sort: DEFAULT_DOCUMENTS_SORT,
        layout: DEFAULT_DOCUMENTS_LAYOUT,
      };
    }
    const parsed = JSON.parse(raw);
    return {
      pageSize: normalizeDocumentsPageSize(parsed?.pageSize),
      sort: normalizeDocumentsSort(parsed?.sort),
      layout: normalizeDocumentsLayout(parsed?.layout),
    };
  } catch {
    return {
      pageSize: DEFAULT_DOCUMENTS_PAGE_SIZE,
      sort: DEFAULT_DOCUMENTS_SORT,
      layout: DEFAULT_DOCUMENTS_LAYOUT,
    };
  }
};

const persistFilesViewPreferences = ({ pageSize, sort, layout }) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(
      FILES_VIEW_PREFS_KEY,
      JSON.stringify({
        pageSize: normalizeDocumentsPageSize(pageSize),
        sort: normalizeDocumentsSort(sort),
        layout: normalizeDocumentsLayout(layout),
      })
    );
  } catch {
    // Ignore localStorage write failures (private mode / quota).
  }
};

const createSavedViewsScopeKey = (accountName, workspaceId) => {
  const accountKey = String(accountName || 'Guest').trim().toLowerCase() || 'guest';
  const workspaceKey = String(workspaceId || '__default__').trim() || '__default__';
  return `${accountKey}::${workspaceKey}`;
};

const normalizeSavedView = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().slice(0, 48);
  if (!name) return null;
  const filters = raw.filters && typeof raw.filters === 'object' ? raw.filters : {};
  return {
    id: String(raw.id || '').trim() || createSavedViewId(),
    name,
    filters: {
      query: String(filters.query || '').trim(),
      start: String(filters.start || '').trim(),
      end: String(filters.end || '').trim(),
      tag: String(filters.tag || '').trim(),
      category: String(filters.category || '').trim(),
      fileType: normalizeFileTypeFilter(filters.fileType),
    },
    sort: normalizeDocumentsSort(raw.sort),
    pageSize: normalizeDocumentsPageSize(raw.pageSize),
    layout: normalizeDocumentsLayout(raw.layout),
    pinned: Boolean(raw.pinned),
    createdAt: String(raw.createdAt || ''),
    updatedAt: String(raw.updatedAt || ''),
  };
};

const loadSavedViews = (accountName, workspaceId) => {
  if (typeof window === 'undefined') return [];
  const scopeKey = createSavedViewsScopeKey(accountName, workspaceId);
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_VIEWS_STORE_KEY) || '{}');
    const bucket = Array.isArray(parsed?.[scopeKey]) ? parsed[scopeKey] : [];
    return bucket
      .map((item) => normalizeSavedView(item))
      .filter(Boolean)
      .slice(0, MAX_SAVED_VIEWS_PER_WORKSPACE);
  } catch {
    return [];
  }
};

const persistSavedViews = (accountName, workspaceId, views) => {
  if (typeof window === 'undefined') return;
  const scopeKey = createSavedViewsScopeKey(accountName, workspaceId);
  const normalized = Array.isArray(views)
    ? views.map((item) => normalizeSavedView(item)).filter(Boolean).slice(0, MAX_SAVED_VIEWS_PER_WORKSPACE)
    : [];
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_VIEWS_STORE_KEY) || '{}');
    const nextStore = parsed && typeof parsed === 'object' ? { ...parsed } : {};
    nextStore[scopeKey] = normalized;
    localStorage.setItem(SAVED_VIEWS_STORE_KEY, JSON.stringify(nextStore));
  } catch {
    // Ignore localStorage write failures (private mode / quota).
  }
};

const normalizeStarredNoteEntry = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const id = toPositiveDocId(raw.id);
  if (!id) return null;
  const title = String(raw.title || '').trim().slice(0, 200) || `Note ${id}`;
  return {
    id,
    title,
    fileType: String(raw.fileType || '').trim().toLowerCase(),
    updatedAt: String(raw.updatedAt || ''),
  };
};

const loadStarredNotes = (accountName, workspaceId) => {
  if (typeof window === 'undefined') return [];
  const scopeKey = createSavedViewsScopeKey(accountName, workspaceId);
  try {
    const parsed = JSON.parse(localStorage.getItem(STARRED_NOTES_STORE_KEY) || '{}');
    const bucket = Array.isArray(parsed?.[scopeKey]) ? parsed[scopeKey] : [];
    return bucket
      .map((item) => normalizeStarredNoteEntry(item))
      .filter(Boolean)
      .slice(0, MAX_STARRED_NOTES_PER_WORKSPACE);
  } catch {
    return [];
  }
};

const persistStarredNotes = (accountName, workspaceId, starredNotes) => {
  if (typeof window === 'undefined') return;
  const scopeKey = createSavedViewsScopeKey(accountName, workspaceId);
  const normalized = Array.isArray(starredNotes)
    ? starredNotes
        .map((item) => normalizeStarredNoteEntry(item))
        .filter(Boolean)
        .slice(0, MAX_STARRED_NOTES_PER_WORKSPACE)
    : [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STARRED_NOTES_STORE_KEY) || '{}');
    const nextStore = parsed && typeof parsed === 'object' ? { ...parsed } : {};
    nextStore[scopeKey] = normalized;
    localStorage.setItem(STARRED_NOTES_STORE_KEY, JSON.stringify(nextStore));
  } catch {
    // Ignore localStorage write failures (private mode / quota).
  }
};

const normalizeRecentNoteEntry = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const id = toPositiveDocId(raw.id);
  if (!id) return null;
  const title = String(raw.title || '').trim().slice(0, 200) || `Note ${id}`;
  return {
    id,
    title,
    fileType: String(raw.fileType || '').trim().toLowerCase(),
    updatedAt: String(raw.updatedAt || ''),
  };
};

const loadRecentNotes = (accountName, workspaceId) => {
  if (typeof window === 'undefined') return [];
  const scopeKey = createSavedViewsScopeKey(accountName, workspaceId);
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_NOTES_STORE_KEY) || '{}');
    const bucket = Array.isArray(parsed?.[scopeKey]) ? parsed[scopeKey] : [];
    return bucket
      .map((item) => normalizeRecentNoteEntry(item))
      .filter(Boolean)
      .slice(0, MAX_RECENT_NOTES_PER_WORKSPACE);
  } catch {
    return [];
  }
};

const persistRecentNotes = (accountName, workspaceId, recentNotes) => {
  if (typeof window === 'undefined') return;
  const scopeKey = createSavedViewsScopeKey(accountName, workspaceId);
  const normalized = Array.isArray(recentNotes)
    ? recentNotes
        .map((item) => normalizeRecentNoteEntry(item))
        .filter(Boolean)
        .slice(0, MAX_RECENT_NOTES_PER_WORKSPACE)
    : [];
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_NOTES_STORE_KEY) || '{}');
    const nextStore = parsed && typeof parsed === 'object' ? { ...parsed } : {};
    nextStore[scopeKey] = normalized;
    localStorage.setItem(RECENT_NOTES_STORE_KEY, JSON.stringify(nextStore));
  } catch {
    // Ignore localStorage write failures (private mode / quota).
  }
};

const normalizeSummaryHistoryEntry = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim() || createClientId('summary');
  const docId = toPositiveDocId(raw.docId || raw.doc_id || raw.document_id);
  const title = String(raw.title || '').trim().slice(0, 200);
  const summary = String(raw.summary || '').trim();
  const options = raw.optionsUsed && typeof raw.optionsUsed === 'object'
    ? raw.optionsUsed
    : (raw.options_used && typeof raw.options_used === 'object' ? raw.options_used : {});
  const chunkCount = Math.max(
    1,
    Number(raw.chunkCount ?? raw.chunk_count ?? options.chunk_count) || 1
  );
  const mergeRounds = Math.max(
    0,
    Number(raw.mergeRounds ?? raw.merge_rounds ?? options.merge_rounds) || 0
  );
  const textWordCount = Math.max(
    0,
    Number(raw.textWordCount ?? raw.text_word_count ?? options.text_word_count) || 0
  );
  const textCharCount = Math.max(
    0,
    Number(raw.textCharCount ?? raw.text_char_count ?? options.text_char_count) || 0
  );
  if (!summary) return null;
  return {
    id,
    docId,
    title: title || (docId ? `Note ${docId}` : 'Untitled note'),
    fileType: String(raw.fileType || raw.file_type || '').trim().toLowerCase(),
    summary,
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map((item) => String(item || '').trim()).filter(Boolean) : [],
    keySentences: Array.isArray(raw.keySentences || raw.key_sentences)
      ? (raw.keySentences || raw.key_sentences)
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      : [],
    summarySource: normalizeSummarySource(raw.summarySource || raw.summary_source || 'fallback'),
    summaryNote: String(raw.summaryNote || raw.summary_note || '').trim(),
    summaryLength: String(raw.summaryLength || raw.summary_length || 'medium').trim().toLowerCase() || 'medium',
    chunkCount,
    mergeRounds,
    refreshedFromFile: Boolean(
      raw.refreshedFromFile ?? raw.refreshed_from_file ?? options.refreshed_from_file
    ),
    pdfExtractor: String(raw.pdfExtractor || raw.pdf_extractor || options.pdf_extractor || '').trim(),
    pdfOcrUsed: Boolean(raw.pdfOcrUsed ?? raw.pdf_ocr_used ?? options.pdf_ocr_used),
    textWordCount,
    textCharCount,
    summarizerModel: String(raw.summarizerModel || raw.summarizer_model || options.summarizer_model || '').trim(),
    generatedAt: String(raw.generatedAt || raw.generated_at || raw.updatedAt || new Date().toISOString()),
  };
};

const loadSummaryHistory = (accountName, workspaceId) => {
  if (typeof window === 'undefined') return [];
  const scopeKey = createSavedViewsScopeKey(accountName, workspaceId);
  try {
    const parsed = JSON.parse(localStorage.getItem(SUMMARY_HISTORY_STORE_KEY) || '{}');
    const bucket = Array.isArray(parsed?.[scopeKey]) ? parsed[scopeKey] : [];
    return bucket
      .map((item) => normalizeSummaryHistoryEntry(item))
      .filter(Boolean)
      .slice(0, MAX_SUMMARY_HISTORY_PER_WORKSPACE);
  } catch {
    return [];
  }
};

const persistSummaryHistory = (accountName, workspaceId, entries) => {
  if (typeof window === 'undefined') return;
  const scopeKey = createSavedViewsScopeKey(accountName, workspaceId);
  const normalized = Array.isArray(entries)
    ? entries
        .map((item) => normalizeSummaryHistoryEntry(item))
        .filter(Boolean)
        .slice(0, MAX_SUMMARY_HISTORY_PER_WORKSPACE)
    : [];
  try {
    const parsed = JSON.parse(localStorage.getItem(SUMMARY_HISTORY_STORE_KEY) || '{}');
    const nextStore = parsed && typeof parsed === 'object' ? { ...parsed } : {};
    nextStore[scopeKey] = normalized;
    localStorage.setItem(SUMMARY_HISTORY_STORE_KEY, JSON.stringify(nextStore));
  } catch {
    // Ignore localStorage write failures (private mode / quota).
  }
};

const viewMatchesSnapshot = (view, snapshot) =>
  Boolean(view) &&
  Boolean(snapshot) &&
  normalizeDocumentsSort(view.sort) === normalizeDocumentsSort(snapshot.sort) &&
  normalizeDocumentsPageSize(view.pageSize) === normalizeDocumentsPageSize(snapshot.pageSize) &&
  normalizeDocumentsLayout(view.layout) === normalizeDocumentsLayout(snapshot.layout) &&
  String(view?.filters?.query || '') === String(snapshot?.filters?.query || '') &&
  String(view?.filters?.start || '') === String(snapshot?.filters?.start || '') &&
  String(view?.filters?.end || '') === String(snapshot?.filters?.end || '') &&
  String(view?.filters?.tag || '') === String(snapshot?.filters?.tag || '') &&
  String(view?.filters?.category || '') === String(snapshot?.filters?.category || '') &&
  normalizeFileTypeFilter(view?.filters?.fileType) === normalizeFileTypeFilter(snapshot?.filters?.fileType);

const clamp = (value, minValue, maxValue) => Math.min(maxValue, Math.max(minValue, value));

const normalizeWorkspaceIcon = (value) => {
  const safeValue = String(value || '').trim();
  if (isWorkspaceImageIcon(safeValue)) return safeValue;
  if (safeValue.toLowerCase().startsWith('data:')) return DEFAULT_WORKSPACE_SETTINGS.workspace_icon;
  return safeValue.slice(0, 2) || DEFAULT_WORKSPACE_SETTINGS.workspace_icon;
};

const normalizeWorkspaceSettings = (raw) => {
  const source = raw && typeof raw === 'object' ? raw : {};
  const workspaceIcon = String(source.workspace_icon || DEFAULT_WORKSPACE_SETTINGS.workspace_icon).trim();
  const summaryLength = SUMMARY_LENGTH_OPTIONS.includes(String(source.summary_length || '').toLowerCase())
    ? String(source.summary_length).toLowerCase()
    : DEFAULT_WORKSPACE_SETTINGS.summary_length;
  const linkMode = LINK_SHARING_MODES.includes(String(source.link_sharing_mode || '').toLowerCase())
    ? String(source.link_sharing_mode).toLowerCase()
    : DEFAULT_WORKSPACE_SETTINGS.link_sharing_mode;
  const rawDefaultHomeTab = String(source.default_home_tab || '').toLowerCase();
  const defaultHomeTab = HOME_TAB_OPTIONS.includes(rawDefaultHomeTab === 'ai' ? 'files' : rawDefaultHomeTab)
    ? (rawDefaultHomeTab === 'ai' ? 'files' : rawDefaultHomeTab)
    : DEFAULT_WORKSPACE_SETTINGS.default_home_tab;
  const defaultDocumentsLayout = normalizeDocumentsLayout(
    source.default_documents_layout || DEFAULT_WORKSPACE_SETTINGS.default_documents_layout
  );
  const defaultDocumentsSort = normalizeDocumentsSort(
    source.default_documents_sort || DEFAULT_WORKSPACE_SETTINGS.default_documents_sort
  );
  const defaultDocumentsPageSize = normalizeDocumentsPageSize(
    Number(source.default_documents_page_size) || DEFAULT_WORKSPACE_SETTINGS.default_documents_page_size
  );
  const sidebarDensity = normalizeSidebarDensity(source.sidebar_density);
  const allowedEmailDomains = normalizeWorkspaceDomainList(source.allowed_email_domains);
  const blockedEmailDomains = normalizeWorkspaceDomainList(source.blocked_email_domains);

  return {
    workspace_icon: normalizeWorkspaceIcon(workspaceIcon),
    description: String(source.description || '').trim().slice(0, 220),
    accent_color: normalizeAccentColor(source.accent_color || DEFAULT_WORKSPACE_SETTINGS.accent_color),
    default_category: normalizeCategory(source.default_category || DEFAULT_WORKSPACE_SETTINGS.default_category),
    auto_categorize: Boolean(source.auto_categorize ?? DEFAULT_WORKSPACE_SETTINGS.auto_categorize),
    default_home_tab: defaultHomeTab,
    default_documents_layout: defaultDocumentsLayout,
    default_documents_sort: defaultDocumentsSort,
    default_documents_page_size: defaultDocumentsPageSize,
    recent_items_limit: clamp(
      Number(source.recent_items_limit) || DEFAULT_WORKSPACE_SETTINGS.recent_items_limit,
      MIN_SIDEBAR_RECENT_LIMIT,
      MAX_SIDEBAR_RECENT_LIMIT
    ),
    sidebar_density: sidebarDensity,
    show_starred_section: Boolean(
      source.show_starred_section ?? DEFAULT_WORKSPACE_SETTINGS.show_starred_section
    ),
    show_recent_section: Boolean(
      source.show_recent_section ?? DEFAULT_WORKSPACE_SETTINGS.show_recent_section
    ),
    show_quick_actions: Boolean(
      source.show_quick_actions ?? DEFAULT_WORKSPACE_SETTINGS.show_quick_actions
    ),
    show_usage_chart: Boolean(
      source.show_usage_chart ?? DEFAULT_WORKSPACE_SETTINGS.show_usage_chart
    ),
    show_recent_activity: Boolean(
      source.show_recent_activity ?? DEFAULT_WORKSPACE_SETTINGS.show_recent_activity
    ),
    allow_uploads: Boolean(source.allow_uploads ?? DEFAULT_WORKSPACE_SETTINGS.allow_uploads),
    allow_note_editing: Boolean(
      source.allow_note_editing ?? DEFAULT_WORKSPACE_SETTINGS.allow_note_editing
    ),
    allow_ai_tools: Boolean(source.allow_ai_tools ?? DEFAULT_WORKSPACE_SETTINGS.allow_ai_tools),
    allow_ocr: Boolean(source.allow_ocr ?? DEFAULT_WORKSPACE_SETTINGS.allow_ocr),
    summary_length: summaryLength,
    keyword_limit: clamp(Number(source.keyword_limit) || DEFAULT_WORKSPACE_SETTINGS.keyword_limit, 3, 12),
    notify_upload_events: Boolean(
      source.notify_upload_events ?? DEFAULT_WORKSPACE_SETTINGS.notify_upload_events
    ),
    notify_summary_events: Boolean(
      source.notify_summary_events ?? DEFAULT_WORKSPACE_SETTINGS.notify_summary_events
    ),
    notify_sharing_events: Boolean(
      source.notify_sharing_events ?? DEFAULT_WORKSPACE_SETTINGS.notify_sharing_events
    ),
    allow_member_invites: Boolean(
      source.allow_member_invites ?? DEFAULT_WORKSPACE_SETTINGS.allow_member_invites
    ),
    default_invite_expiry_days: clamp(
      Number(source.default_invite_expiry_days) || DEFAULT_WORKSPACE_SETTINGS.default_invite_expiry_days,
      1,
      30
    ),
    default_share_expiry_days: clamp(
      Number(source.default_share_expiry_days) || DEFAULT_WORKSPACE_SETTINGS.default_share_expiry_days,
      1,
      30
    ),
    link_sharing_mode: linkMode,
    restrict_invites_to_domains: Boolean(
      source.restrict_invites_to_domains ?? DEFAULT_WORKSPACE_SETTINGS.restrict_invites_to_domains
    ),
    allowed_email_domains: allowedEmailDomains,
    block_invites_from_domains: Boolean(
      source.block_invites_from_domains ?? DEFAULT_WORKSPACE_SETTINGS.block_invites_from_domains
    ),
    blocked_email_domains: blockedEmailDomains,
    allow_member_share_management: Boolean(
      source.allow_member_share_management ?? DEFAULT_WORKSPACE_SETTINGS.allow_member_share_management
    ),
    max_active_share_links_per_document: clamp(
      Number(source.max_active_share_links_per_document) ||
        DEFAULT_WORKSPACE_SETTINGS.max_active_share_links_per_document,
      1,
      20
    ),
    auto_revoke_previous_share_links: Boolean(
      source.auto_revoke_previous_share_links ?? DEFAULT_WORKSPACE_SETTINGS.auto_revoke_previous_share_links
    ),
    allow_export: Boolean(source.allow_export ?? DEFAULT_WORKSPACE_SETTINGS.allow_export),
  };
};

const normalizeUserNotificationPreferences = (raw) => {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rawEmailValue =
    source.emailNotificationsEnabled ??
    source.email_notifications_enabled ??
    source.preferences?.email_notifications_enabled ??
    DEFAULT_USER_NOTIFICATION_PREFERENCES.emailNotificationsEnabled;
  return {
    emailNotificationsEnabled: Boolean(rawEmailValue),
  };
};

const normalizeAccountRecord = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const username = raw.trim();
    if (!username) return null;
    return {
      username,
      email: '',
      lastActiveAt: '',
    };
  }
  if (typeof raw !== 'object') return null;

  const username = String(raw.username || '').trim();
  if (!username) return null;
  return {
    username,
    email: String(raw.email || '').trim(),
    lastActiveAt: String(raw.lastActiveAt || raw.last_login || raw.lastLogin || ''),
  };
};

const normalizeAccounts = (rawList) => {
  if (!Array.isArray(rawList)) return [];
  const map = new Map();
  rawList.forEach((item) => {
    const normalized = normalizeAccountRecord(item);
    if (!normalized) return;
    const existing = map.get(normalized.username);
    if (!existing) {
      map.set(normalized.username, normalized);
      return;
    }
    map.set(normalized.username, {
      username: normalized.username,
      email: normalized.email || existing.email,
      lastActiveAt: normalized.lastActiveAt || existing.lastActiveAt,
    });
  });
  return Array.from(map.values()).slice(0, MAX_SAVED_ACCOUNTS);
};

const upsertAccount = (rawList, account) => {
  const normalizedAccount = normalizeAccountRecord(account);
  const normalizedList = normalizeAccounts(rawList);
  if (!normalizedAccount) return normalizedList;

  const next = [
    {
      ...normalizedAccount,
      lastActiveAt: new Date().toISOString(),
    },
    ...normalizedList.filter((item) => item.username !== normalizedAccount.username),
  ];
  return next.slice(0, MAX_SAVED_ACCOUNTS);
};

const memberCountOfWorkspace = (workspace, accountName) => {
  if (!workspace) return 0;
  const countFromServer = Number(workspace.members_count ?? workspace.membersCount);
  if (Number.isFinite(countFromServer) && countFromServer > 0) return countFromServer;
  const bag = new Set();
  const owner = String(accountName || '').trim();
  if (owner) bag.add(owner);
  if (Array.isArray(workspace.members)) {
    workspace.members.forEach((member) => {
      const value = String(member || '').trim();
      if (value) bag.add(value);
    });
  }
  if (Array.isArray(workspace.invites)) {
    workspace.invites.forEach((invite) => {
      const value = String(invite || '').trim();
      if (value) bag.add(value.toLowerCase());
    });
  }
  return bag.size;
};

const toTimeMs = (value) => {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

const normalizeTags = (tags) => {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string' && tags.trim()) {
    return tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
};

const normalizeCategory = (value) => {
  const next = String(value || '').trim();
  return next || DEFAULT_NOTE_CATEGORY;
};

const normalizeProcessingStatus = (value) => String(value || '').trim().toLowerCase();

const getDocumentProcessingMeta = (doc) =>
  PROCESSING_STATUS_META[normalizeProcessingStatus(doc?.processingStatus ?? doc?.processing_status)] || null;

const getDocumentProcessingMessage = (doc) => {
  const meta = getDocumentProcessingMeta(doc);
  if (!meta) return '';
  const status = normalizeProcessingStatus(doc?.processingStatus ?? doc?.processing_status);
  if (['failed', 'text_pending', 'needs_ocr', 'no_text_available', 'action_required'].includes(status)) {
    return String(doc?.processingError ?? doc?.processing_error ?? '').replace(/\s+/g, ' ').trim() || meta.message;
  }
  return meta.message;
};

const normalizeDocument = (doc) => ({
  ...doc,
  uploadedAt: doc.uploaded_at ?? doc.uploadedAt ?? '',
  deletedAt: doc.deleted_at ?? doc.deletedAt ?? '',
  lastAccessAt: doc.last_access_at ?? doc.lastAccessAt ?? '',
  processingStatus: normalizeProcessingStatus(doc.processing_status ?? doc.processingStatus),
  processingError: String(doc.processing_error ?? doc.processingError ?? '').replace(/\s+/g, ' ').trim(),
  processingStartedAt: doc.processing_started_at ?? doc.processingStartedAt ?? '',
  processedAt: doc.processed_at ?? doc.processedAt ?? '',
  contentHtml: doc.content_html ?? doc.contentHtml ?? '',
  category: normalizeCategory(doc.category),
  content: String(doc.content || ''),
  tags: normalizeTags(doc.tags),
});

const workspaceIconLabel = (workspace, fallback = 'W') => {
  const icon = String(workspace?.settings?.workspace_icon || '').trim();
  if (icon) return normalizeWorkspaceIcon(icon);
  return String(fallback || 'W').slice(0, 1).toUpperCase();
};

const getDocExt = (doc) => {
  if (!doc) return '';
  const rawType = String(doc.fileType || doc.file_type || '').toLowerCase();
  if (rawType && !rawType.includes('/')) return rawType;
  const name = String(doc.filename || doc.title || '').toLowerCase();
  const parts = name.split('.');
  return parts.length > 1 ? parts.pop() : '';
};

const replaceFileExtension = (title, ext, fallback = 'Edited document') => {
  const safeExt = String(ext || '').trim().toLowerCase().replace(/^\./, '');
  const base = String(title || fallback)
    .trim()
    .replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .trim() || fallback;
  return safeExt ? `${base}.${safeExt}` : base;
};

const buildFileTypeCountsFromDocuments = (docs) => {
  const counts = {};
  (Array.isArray(docs) ? docs : []).forEach((doc) => {
    const ext = String(getDocExt(doc) || '').trim().toLowerCase();
    if (!ext) return;
    counts[ext] = (counts[ext] || 0) + 1;
    if (IMAGE_FILE_TYPE_VALUES.has(ext)) {
      counts.image = (counts.image || 0) + 1;
    }
  });
  return counts;
};

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const plainTextToRichHtml = (value) => {
  const text = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');
  if (!lines.length) return '<p><br></p>';
  return lines.map((line) => (line ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>')).join('');
};

const RICH_HTML_ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'mark', 'span', 'div',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre',
  'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col', 'img', 'hr',
]);

const RICH_HTML_ALLOWED_STYLE_PROPS = new Set([
  'font-weight', 'font-style', 'text-decoration', 'color', 'background-color',
  'text-align', 'font-size', 'font-family', 'vertical-align', 'margin-left',
  'width', 'height', 'border', 'border-collapse',
]);

const sanitizeRichHtmlStyle = (styleValue) => {
  const declarations = String(styleValue || '').split(';');
  const cleanDeclarations = [];
  declarations.forEach((declaration) => {
    const separatorIndex = declaration.indexOf(':');
    if (separatorIndex <= 0) return;
    const prop = declaration.slice(0, separatorIndex).trim().toLowerCase();
    const value = declaration.slice(separatorIndex + 1).trim();
    const loweredValue = value.toLowerCase();
    if (!RICH_HTML_ALLOWED_STYLE_PROPS.has(prop) || !value) return;
    if (loweredValue.includes('url(') || loweredValue.includes('expression(') || loweredValue.includes('javascript:')) return;
    cleanDeclarations.push(`${prop}: ${value}`);
  });
  return cleanDeclarations.join('; ');
};

const isSafeRichHtmlHref = (value) => {
  const href = String(value || '').trim();
  if (!href) return false;
  const lowered = href.toLowerCase();
  if (lowered.startsWith('#') || lowered.startsWith('/') || lowered.startsWith('./') || lowered.startsWith('../')) {
    return true;
  }
  return lowered.startsWith('http://') || lowered.startsWith('https://') || lowered.startsWith('mailto:');
};

const isSafeRichHtmlImageSrc = (value) => {
  const src = String(value || '').trim();
  if (!src) return false;
  const lowered = src.toLowerCase();
  if (lowered.startsWith('/') || lowered.startsWith('./') || lowered.startsWith('../')) return true;
  if (lowered.startsWith('http://') || lowered.startsWith('https://') || lowered.startsWith('blob:')) return true;
  return /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src);
};

const unwrapRichHtmlElement = (element) => {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) {
    parent.insertBefore(element.firstChild, element);
  }
  parent.removeChild(element);
};

const sanitizeRichHtmlForView = (value) => {
  const sourceHtml = String(value || '').trim();
  if (!sourceHtml) return '<p><br></p>';
  try {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(`<div>${sourceHtml}</div>`, 'text/html');
    const root = parsed.body.firstElementChild;
    if (!root) return '<p><br></p>';

    Array.from(root.querySelectorAll('script, style')).forEach((element) => element.remove());
    Array.from(root.querySelectorAll('*')).forEach((element) => {
      const tag = element.tagName.toLowerCase();
      if (!RICH_HTML_ALLOWED_TAGS.has(tag)) {
        unwrapRichHtmlElement(element);
        return;
      }

      const sanitizedAttrs = {};
      const style = sanitizeRichHtmlStyle(element.getAttribute('style'));
      if (style) sanitizedAttrs.style = style;

      if (tag === 'a') {
        const href = element.getAttribute('href');
        if (isSafeRichHtmlHref(href)) {
          sanitizedAttrs.href = href.trim();
          sanitizedAttrs.target = '_blank';
          sanitizedAttrs.rel = 'noopener noreferrer';
        }
      } else if (tag === 'img') {
        const src = element.getAttribute('src');
        if (isSafeRichHtmlImageSrc(src)) sanitizedAttrs.src = src.trim();
        const alt = String(element.getAttribute('alt') || '').trim();
        if (alt) sanitizedAttrs.alt = alt.slice(0, 200);
        const title = String(element.getAttribute('title') || '').trim();
        if (title) sanitizedAttrs.title = title.slice(0, 200);
        ['width', 'height'].forEach((attrName) => {
          const attrValue = Number.parseInt(element.getAttribute(attrName) || '', 10);
          if (Number.isInteger(attrValue) && attrValue >= 1 && attrValue <= 4000) {
            sanitizedAttrs[attrName] = String(attrValue);
          }
        });
      } else if (tag === 'th' || tag === 'td') {
        ['colspan', 'rowspan'].forEach((attrName) => {
          const attrValue = Number.parseInt(element.getAttribute(attrName) || '', 10);
          const maxValue = attrName === 'colspan' ? 20 : 100;
          if (Number.isInteger(attrValue) && attrValue > 1 && attrValue <= maxValue) {
            sanitizedAttrs[attrName] = String(attrValue);
          }
        });
      } else if (tag === 'col') {
        const span = Number.parseInt(element.getAttribute('span') || '', 10);
        if (Number.isInteger(span) && span > 1 && span <= 20) sanitizedAttrs.span = String(span);
        const width = Number.parseInt(element.getAttribute('width') || '', 10);
        if (Number.isInteger(width) && width >= 1 && width <= 4000) sanitizedAttrs.width = String(width);
      }

      Array.from(element.attributes).forEach((attr) => element.removeAttribute(attr.name));
      Object.entries(sanitizedAttrs).forEach(([attrName, attrValue]) => {
        element.setAttribute(attrName, attrValue);
      });
    });

    return root.innerHTML.trim() || '<p><br></p>';
  } catch {
    return plainTextToRichHtml(value);
  }
};

const richHtmlToPlainText = (value) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  const normalizedHtml = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|ul|ol)>/gi, '\n');
  try {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(`<div>${normalizedHtml}</div>`, 'text/html');
    return (parsed.body.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return normalizedHtml.replace(/<[^>]+>/g, '').trim();
  }
};

const getDocumentRichHtml = (doc) => {
  if (!doc) return '';
  if (typeof doc.content_html === 'string' && doc.content_html.trim()) return doc.content_html;
  if (typeof doc.contentHtml === 'string' && doc.contentHtml.trim()) return doc.contentHtml;
  return plainTextToRichHtml(doc.content || '');
};

const DocumentsList = lazy(() => import('../components/DocumentsList.jsx'));
const UsageChart = lazy(() => import('../components/UsageChart.jsx'));
const WorkspaceSettingsModal = lazy(() => import('../components/WorkspaceSettingsModal.jsx'));
const WorkspaceInviteModal = lazy(() => import('../components/WorkspaceInviteModal.jsx'));
const RichTextEditor = lazy(() => import('../components/RichTextEditor.jsx'));
const PdfInlineViewer = lazy(() => import('../components/PdfInlineViewer.jsx'));

export default function HomePage() {
  const [selectedDocumentIds, setSelectedDocumentIds] = useState([]);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [selectAllMatchedLoading, setSelectAllMatchedLoading] = useState(false);
  const [bulkCategoryDraft, setBulkCategoryDraft] = useState('');
  const [bulkTagsDraft, setBulkTagsDraft] = useState('');
  const [bulkResultSummary, setBulkResultSummary] = useState(DEFAULT_BULK_RESULT_SUMMARY);
  const [toastState, setToastState] = useState(DEFAULT_TOAST_STATE);
  const [confirmDialogState, setConfirmDialogState] = useState(DEFAULT_CONFIRM_DIALOG_STATE);
  const [inputDialogState, setInputDialogState] = useState(DEFAULT_INPUT_DIALOG_STATE);
  const [inputDialogDraft, setInputDialogDraft] = useState('');
  const [savedViews, setSavedViews] = useState([]);
  const [activeSavedViewId, setActiveSavedViewId] = useState('');
  const [savedViewsMenuOpen, setSavedViewsMenuOpen] = useState(false);
  const [trashModalOpen, setTrashModalOpen] = useState(false);
  const [trashItems, setTrashItems] = useState([]);
  const [trashTotal, setTrashTotal] = useState(0);
  const [trashRetentionDays, setTrashRetentionDays] = useState(30);
  const [trashPurgedCount, setTrashPurgedCount] = useState(0);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashLoadError, setTrashLoadError] = useState('');
  const [trashActionLoadingId, setTrashActionLoadingId] = useState('');
  const [selectedTrashDocumentIds, setSelectedTrashDocumentIds] = useState([]);
  const [trashBulkActionLoading, setTrashBulkActionLoading] = useState(false);
  const [trashPage, setTrashPage] = useState(1);
  const [trashPageSize, setTrashPageSize] = useState(TRASH_PAGE_SIZE_OPTIONS[1]);
  const [trashSort, setTrashSort] = useState('deleted_newest');
  const [trashQuery, setTrashQuery] = useState('');
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const preferredWorkspaceIdFromNavigation = useMemo(() => {
    const stateWorkspaceId = String(
      location.state?.preferredWorkspaceId || location.state?.workspaceId || ''
    ).trim();
    if (stateWorkspaceId) return stateWorkspaceId;
    try {
      const params = new URLSearchParams(location.search || '');
      return String(params.get('workspace_id') || params.get('workspaceId') || '').trim();
    } catch {
      return '';
    }
  }, [location.search, location.state]);
  const workspaceMenuRef = useRef(null);
  const recentMenuRef = useRef(null);
  const savedViewsMenuRef = useRef(null);
  const searchInputRef = useRef(null);
  const savedViewsImportInputRef = useRef(null);
  const trashRequestSeqRef = useRef(0);
  const ocrImageInputRef = useRef(null);
  const pendingOcrSourceRef = useRef(null);
  const toastTimerRef = useRef(null);
  const confirmResolverRef = useRef(null);
  const inputDialogResolverRef = useRef(null);
  const summaryProgressTimerRef = useRef(null);
  const forceFilesViewAfterWorkspaceChangeRef = useRef(false);
  const initialAuthSession = readStoredAuthSession();
  const hasInitialAuthenticatedSession = initialAuthSession.isAuthenticated;
  const [isLoggedIn, setIsLoggedIn] = useState(
    () => hasInitialAuthenticatedSession
  );
  const [showFiles, setShowFiles] = useState(() => location.state?.showFiles || false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_STORE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [workspaceInviteOpen, setWorkspaceInviteOpen] = useState(false);
  const [accountManagerOpen, setAccountManagerOpen] = useState(false);
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false);
  const [workspaceLoading, setWorkspaceLoading] = useState(() => hasInitialAuthenticatedSession);
  const [workspaceReady, setWorkspaceReady] = useState(() => !hasInitialAuthenticatedSession);
  const [workspaceActionLoading, setWorkspaceActionLoading] = useState(false);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState('');
  const [workspaceSettingsDraft, setWorkspaceSettingsDraft] = useState(() =>
    normalizeWorkspaceSettings(DEFAULT_WORKSPACE_SETTINGS)
  );
  const [workspaceSettingsTab, setWorkspaceSettingsTab] = useState('general');
  const [workspaceInviteDraft, setWorkspaceInviteDraft] = useState('');
  const [latestInviteDelivery, setLatestInviteDelivery] = useState(null);
  const [messagesOpenRequest, setMessagesOpenRequest] = useState({ key: 0, tab: 'friends' });
  const [userNotificationPreferences, setUserNotificationPreferences] = useState(() =>
    normalizeUserNotificationPreferences(initialAuthSession.preferences)
  );
  const [userNotificationPreferencesSaving, setUserNotificationPreferencesSaving] = useState(false);
  const [savedAccounts, setSavedAccounts] = useState(() => {
    const fromHistory = normalizeAccounts(loadAccountHistory());
    if (fromHistory.length) return fromHistory;
    const legacy = normalizeAccounts(loadAccounts());
    return legacy;
  });
  const [workspaceState, setWorkspaceState] = useState(() =>
    loadWorkspaceState(initialAuthSession.username || 'Guest')
  );
  const [sidebarMenuDocId, setSidebarMenuDocId] = useState(null);
  const [sidebarRecentIds, setSidebarRecentIds] = useState([]);
  const [sidebarRecentMeta, setSidebarRecentMeta] = useState({});
  const [starredNotes, setStarredNotes] = useState([]);
  const [summaryHistory, setSummaryHistory] = useState([]);
  const [summaryCenterOpen, setSummaryCenterOpen] = useState(false);
  const [summaryCenterQuery, setSummaryCenterQuery] = useState('');
  const [summaryCenterSort, setSummaryCenterSort] = useState('newest');
  const [summaryCenterSource, setSummaryCenterSource] = useState('all');
  const [summaryCenterModel, setSummaryCenterModel] = useState('all');
  const [summaryCenterChunk, setSummaryCenterChunk] = useState('all');
  const [summaryCenterExpandedIds, setSummaryCenterExpandedIds] = useState([]);
  const [summaryCenterActionId, setSummaryCenterActionId] = useState('');
  const [starredDragId, setStarredDragId] = useState(0);
  const [activeDoc, setActiveDoc] = useState(null);
  const [activeDocLoading, setActiveDocLoading] = useState(false);
  const [activeDocError, setActiveDocError] = useState('');
  const [activeDocFileVersion, setActiveDocFileVersion] = useState(0);
  const [activeDocEditMode, setActiveDocEditMode] = useState(false);
  const [activeDocDraftHtml, setActiveDocDraftHtml] = useState('');
  const [activeDocSaveLoading, setActiveDocSaveLoading] = useState(false);
  const [activeDocSaveError, setActiveDocSaveError] = useState('');
  const [pdfConversionDraft, setPdfConversionDraft] = useState(null);
  const [pdfConversionChoiceOpen, setPdfConversionChoiceOpen] = useState(false);
  const [pdfConversionLoading, setPdfConversionLoading] = useState(false);
  const [pdfConversionMode, setPdfConversionMode] = useState('simple');
  const [pdfConversionOutputFormat, setPdfConversionOutputFormat] = useState('docx');
  const [pdfConversionSaveMode, setPdfConversionSaveMode] = useState('replace');
  const [pdfConversionTitle, setPdfConversionTitle] = useState('');
  const [activeDocDownloadLoading, setActiveDocDownloadLoading] = useState(false);
  const [sidebarDownloadDocId, setSidebarDownloadDocId] = useState(0);
  const [activeDocShareLinks, setActiveDocShareLinks] = useState([]);
  const [activeDocShareLinksLoading, setActiveDocShareLinksLoading] = useState(false);
  const [activeDocShareLinksError, setActiveDocShareLinksError] = useState('');
  const [activeDocShareActionLoadingId, setActiveDocShareActionLoadingId] = useState(0);
  const [activeDocShareActionLoadingType, setActiveDocShareActionLoadingType] = useState('');
  const [activeDocShareEmailOpen, setActiveDocShareEmailOpen] = useState(false);
  const [activeDocShareModalMode, setActiveDocShareModalMode] = useState('send');
  const [activeDocShareEmailRecipient, setActiveDocShareEmailRecipient] = useState('');
  const [activeDocShareEmailMessage, setActiveDocShareEmailMessage] = useState('');
  const [activeDocShareEmailExpiryDays, setActiveDocShareEmailExpiryDays] = useState('');
  const [activeDocShareEmailResult, setActiveDocShareEmailResult] = useState(null);
  const [activeDocShareEmailSending, setActiveDocShareEmailSending] = useState(false);
  const docPaneVisible = activeDocLoading || Boolean(activeDocError) || Boolean(activeDoc);
  const [extractedText, setExtractedText] = useState('');
  const [analysisResult, setAnalysisResult] = useState(null);
  const [summaryResultOpen, setSummaryResultOpen] = useState(false);
  const [summaryResultTitle, setSummaryResultTitle] = useState('');
  const [summaryResultHistoryEntry, setSummaryResultHistoryEntry] = useState(null);
  const [summaryResultReturnToCenter, setSummaryResultReturnToCenter] = useState(false);
  const [ocrResultOpen, setOcrResultOpen] = useState(false);
  const [ocrSourceContext, setOcrSourceContext] = useState(null);
  const [ocrSaveFormat, setOcrSaveFormat] = useState('txt');
  const [isExtracting, setIsExtracting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSavingOcrResult, setIsSavingOcrResult] = useState(false);
  const [summaryProgress, setSummaryProgress] = useState(DEFAULT_SUMMARY_PROGRESS);
  const [uploadCategory, setUploadCategory] = useState('');
  const [uploadTrayCollapsed, setUploadTrayCollapsed] = useState(true);
  const [usageMap, setUsageMap] = useState(() => loadUsageMap());
  const sessionStartRef = useRef(null);
  const [now, setNow] = useState(() => new Date());

  const currentAuthSession = readStoredAuthSession();
  const storedUsername = currentAuthSession.username;
  const authToken = currentAuthSession.authToken;
  const username = authToken ? storedUsername : '';
  const accountName = storedUsername || 'Guest';
  const accountEmail = authToken ? (currentAuthSession.email || (storedUsername ? `${storedUsername}` : '')) : '';
  const activeWorkspace = useMemo(() => {
    if (!workspaceState?.workspaces?.length) return null;
    return (
      workspaceState.workspaces.find((item) => item.id === workspaceState.activeWorkspaceId) ||
      workspaceState.workspaces[0]
    );
  }, [workspaceState]);
  const activeWorkspaceId = String(activeWorkspace?.id || workspaceState?.activeWorkspaceId || '');
  const activeWorkspaceIdForDocuments = workspaceReady ? activeWorkspaceId : '';
  const starredDocIdSet = useMemo(
    () => new Set(starredNotes.map((item) => toPositiveDocId(item.id)).filter(Boolean)),
    [starredNotes]
  );
  const activeWorkspaceSettings = useMemo(
    () => normalizeWorkspaceSettings(activeWorkspace?.settings),
    [activeWorkspace?.settings]
  );
  const workspaceThemeStyle = useMemo(
    () => buildWorkspaceThemeStyle(activeWorkspaceSettings),
    [activeWorkspaceSettings]
  );
  const blockedInviteDomains = useMemo(
    () => parseWorkspaceDomainList(activeWorkspaceSettings.blocked_email_domains),
    [activeWorkspaceSettings.blocked_email_domains]
  );
  const canCurrentUserManageShareLinks = useMemo(() => {
    if (!workspaceReady || !isLoggedIn || !username || !activeWorkspace) return false;
    if (activeWorkspace.is_owner === false && !activeWorkspaceSettings.allow_member_share_management) {
      return false;
    }
    return true;
  }, [
    activeWorkspace,
    activeWorkspaceSettings.allow_member_share_management,
    isLoggedIn,
    username,
    workspaceReady,
  ]);
  const activeRecentLimit = useMemo(
    () =>
      clamp(
        Number(activeWorkspaceSettings.recent_items_limit) || DEFAULT_SIDEBAR_RECENT_LIMIT,
        MIN_SIDEBAR_RECENT_LIMIT,
        MAX_SIDEBAR_RECENT_LIMIT
      ),
    [activeWorkspaceSettings.recent_items_limit]
  );
  const sidebarDensityClass =
    activeWorkspaceSettings.sidebar_density === 'compact' ? 'notion-shell-sidebar-compact' : '';
  const summaryHistoryStats = useMemo(() => {
    const base = {
      total: summaryHistory.length,
      cache: 0,
      huggingface: 0,
      fallback: 0,
    };
    summaryHistory.forEach((item) => {
      const source = normalizeSummarySource(item.summarySource);
      if (source === 'cache') base.cache += 1;
      else if (source === 'huggingface') base.huggingface += 1;
      else base.fallback += 1;
    });
    return base;
  }, [summaryHistory]);
  const summaryCenterModelOptions = useMemo(() => {
    const modelSet = new Set();
    summaryHistory.forEach((item) => {
      const model = String(item?.summarizerModel || '').trim();
      if (model) modelSet.add(model);
    });
    return ['all', ...Array.from(modelSet).sort((a, b) => a.localeCompare(b))];
  }, [summaryHistory]);
  const summaryHistoryItems = useMemo(() => {
    const query = String(summaryCenterQuery || '').trim().toLowerCase();
    const sourceFilter = normalizeSummaryCenterSource(summaryCenterSource);
    const modelFilter = String(summaryCenterModel || 'all').trim();
    const chunkFilter = normalizeSummaryCenterChunkFilter(summaryCenterChunk);
    const sortKey = normalizeSummaryCenterSort(summaryCenterSort);
    const filtered = summaryHistory.filter((item) => {
      if (sourceFilter !== 'all' && normalizeSummarySource(item.summarySource) !== sourceFilter) {
        return false;
      }
      const itemModel = String(item?.summarizerModel || '').trim();
      if (modelFilter !== 'all' && itemModel !== modelFilter) {
        return false;
      }
      const chunkCount = Math.max(1, Number(item?.chunkCount) || 1);
      if (chunkFilter === 'single' && chunkCount !== 1) return false;
      if (chunkFilter === 'multi' && chunkCount < 2) return false;
      if (chunkFilter === 'heavy' && chunkCount < 5) return false;
      if (!query) return true;
      const source = [
        item.title,
        item.summary,
        item.fileType,
        itemModel,
        normalizeSummarySource(item.summarySource),
        Array.isArray(item.keywords) ? item.keywords.join(' ') : '',
      ]
        .join(' ')
        .toLowerCase();
      return source.includes(query);
    });
    const sorted = filtered.slice();
    if (sortKey === 'oldest') {
      sorted.sort((a, b) => toTimeMs(a.generatedAt) - toTimeMs(b.generatedAt));
    } else if (sortKey === 'title_asc') {
      sorted.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    } else {
      sorted.sort((a, b) => toTimeMs(b.generatedAt) - toTimeMs(a.generatedAt));
    }
    return sorted;
  }, [
    summaryCenterQuery,
    summaryCenterSource,
    summaryCenterModel,
    summaryCenterChunk,
    summaryCenterSort,
    summaryHistory,
  ]);
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_STORE_KEY, sidebarCollapsed ? '1' : '0');
    } catch {
      // Ignore storage failures in private browsing or locked-down browsers.
    }
  }, [sidebarCollapsed]);
  useEffect(() => {
    if (summaryCenterModel === 'all') return;
    if (summaryCenterModelOptions.includes(summaryCenterModel)) return;
    setSummaryCenterModel('all');
  }, [summaryCenterModel, summaryCenterModelOptions]);
  const workspaceMemberCount = useMemo(
    () => memberCountOfWorkspace(activeWorkspace, accountName),
    [activeWorkspace, accountName]
  );
  const memberItems = useMemo(
    () => (Array.isArray(activeWorkspace?.members) ? activeWorkspace.members : []),
    [activeWorkspace?.members]
  );
  const inviteItems = useMemo(
    () => (Array.isArray(activeWorkspace?.invites) ? activeWorkspace.invites : []),
    [activeWorkspace?.invites]
  );
  const pendingRequestCount = useMemo(
    () =>
      inviteItems.filter((item) => {
        if (typeof item === 'string') return false;
        return item?.status === 'requested';
      }).length,
    [inviteItems]
  );
  const showToast = (message, tone = 'info') => {
    const nextMessage = String(message || '').trim();
    if (!nextMessage) return;
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToastState({ open: true, message: nextMessage, tone });
    toastTimerRef.current = window.setTimeout(() => {
      setToastState((prev) => ({ ...prev, open: false }));
      toastTimerRef.current = null;
    }, 3600);
  };

  const showWorkspaceToast = (channel, message, tone = 'info') => {
    if (tone === 'warning' || tone === 'error') {
      showToast(message, tone);
      return;
    }
    const safeChannel = String(channel || '').trim();
    if (safeChannel === 'upload' && !activeWorkspaceSettings.notify_upload_events) return;
    if (safeChannel === 'summary' && !activeWorkspaceSettings.notify_summary_events) return;
    if (safeChannel === 'sharing' && !activeWorkspaceSettings.notify_sharing_events) return;
    showToast(message, tone);
  };

  const handleChangeEmailNotifications = async (enabled) => {
    if (!authToken || !username) {
      showToast('Please sign in before changing email reminders.', 'warning');
      return;
    }

    const nextPreferences = { emailNotificationsEnabled: Boolean(enabled) };
    const previousPreferences = userNotificationPreferences;
    setUserNotificationPreferences(nextPreferences);
    setUserNotificationPreferencesSaving(true);
    try {
      const res = await authFetch('/api/auth/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_notifications_enabled: nextPreferences.emailNotificationsEnabled,
        }),
      }, { authToken });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to save email reminder preference');
      const savedPreferences = payload.preferences || payload;
      setUserNotificationPreferences(normalizeUserNotificationPreferences(savedPreferences));
      storeAuthSession({
        username,
        email: accountEmail,
        authToken,
        remember: getRememberAuthPreference(),
        preferences: savedPreferences,
      });
      showToast(
        nextPreferences.emailNotificationsEnabled
          ? 'Email reminders are on.'
          : 'Email reminders are off. Updates will stay in Messages.',
        'success'
      );
    } catch (error) {
      setUserNotificationPreferences(previousPreferences);
      showToast(error.message || 'Failed to save email reminder preference', 'error');
    } finally {
      setUserNotificationPreferencesSaving(false);
    }
  };

  const {
    documents,
    setDocuments,
    documentsTotal,
    setDocumentsTotal,
    documentsPage,
    setDocumentsPage,
    documentsLoading,
    documentsLoadError,
    documentsPageSize,
    setDocumentsPageSize,
    documentsSort,
    setDocumentsSort,
    documentsLayout,
    setDocumentsLayout,
    filters,
    setFilters,
    searchDraft,
    setSearchDraft,
    buildDocumentsQueryParams,
    fetchDocuments,
    filteredDocuments,
    documentsPageCount,
    tags,
    categories,
    categorySuggestions,
    fileTypeFilterCounts,
    activeFilterCount,
    hasActiveFilters,
    advancedFilterCount,
    activeDateRangePresetId,
    activeFilterChips,
    currentViewSnapshot,
    resetDocumentsData,
  } = useDocumentsList({
    username,
    authToken,
    activeWorkspaceId: activeWorkspaceIdForDocuments,
    defaultFilters: DEFAULT_FILTERS,
    defaultDocumentsPageSize: DEFAULT_DOCUMENTS_PAGE_SIZE,
    defaultDocumentsSort: DEFAULT_DOCUMENTS_SORT,
    defaultDocumentsLayout: DEFAULT_DOCUMENTS_LAYOUT,
    defaultNoteCategory: DEFAULT_NOTE_CATEGORY,
    suggestedCategories: SUGGESTED_CATEGORIES,
    fileTypeFilterOptions: FILE_TYPE_FILTER_OPTIONS,
    filterDateRangeOptions: FILTER_DATE_RANGE_OPTIONS,
    loadViewPreferences: loadFilesViewPreferences,
    persistViewPreferences: persistFilesViewPreferences,
    normalizeDocumentsPageSize,
    normalizeDocumentsSort,
    normalizeDocumentsLayout,
    normalizeFileTypeFilter,
    normalizeFacetFileTypeCounts,
    buildFileTypeCountsFromDocuments,
    normalizeDocument,
    normalizeCategory,
    getQuickDateRange,
    formatDisplayDateValue,
    getFileTypeFilterLabel,
  });

  const closeConfirmDialog = (confirmed) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmDialogState(DEFAULT_CONFIRM_DIALOG_STATE);
    if (typeof resolver === 'function') {
      resolver(Boolean(confirmed));
    }
  };

  const requestConfirmation = ({
    title,
    description = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
  }) =>
    new Promise((resolve) => {
      if (typeof confirmResolverRef.current === 'function') {
        confirmResolverRef.current(false);
      }
      confirmResolverRef.current = resolve;
      setConfirmDialogState({
        open: true,
        title: String(title || '').trim() || 'Please confirm',
        description: String(description || '').trim(),
        confirmLabel: String(confirmLabel || '').trim() || 'Confirm',
        cancelLabel: String(cancelLabel || '').trim() || 'Cancel',
        danger: Boolean(danger),
      });
    });

  const closeInputDialog = (confirmed) => {
    const resolver = inputDialogResolverRef.current;
    const trimResult = Boolean(inputDialogState.trimResult);
    const nextValue = confirmed
      ? (trimResult ? String(inputDialogDraft || '').trim() : String(inputDialogDraft || ''))
      : null;
    inputDialogResolverRef.current = null;
    setInputDialogState(DEFAULT_INPUT_DIALOG_STATE);
    setInputDialogDraft('');
    if (typeof resolver === 'function') {
      resolver(nextValue);
    }
  };

  const requestTextInput = ({
    title,
    description = '',
    placeholder = '',
    initialValue = '',
    confirmLabel = 'Save',
    cancelLabel = 'Cancel',
    danger = false,
    required = false,
    trimResult = false,
  }) =>
    new Promise((resolve) => {
      if (typeof inputDialogResolverRef.current === 'function') {
        inputDialogResolverRef.current(null);
      }
      inputDialogResolverRef.current = resolve;
      setInputDialogDraft(String(initialValue || ''));
      setInputDialogState({
        open: true,
        title: String(title || '').trim() || 'Enter value',
        description: String(description || '').trim(),
        placeholder: String(placeholder || '').trim(),
        initialValue: String(initialValue || ''),
        confirmLabel: String(confirmLabel || '').trim() || 'Save',
        cancelLabel: String(cancelLabel || '').trim() || 'Cancel',
        danger: Boolean(danger),
        required: Boolean(required),
        trimResult: Boolean(trimResult),
      });
    });

  const refreshWorkspaces = async (options = {}) => {
    const preserveActive = options.preserveActive ?? true;
    const preferredWorkspaceId = String(options.preferredWorkspaceId || '');

    if (!isLoggedIn || !username) {
      const localState = loadWorkspaceState(accountName);
      const activeId = preserveActive && workspaceState?.activeWorkspaceId &&
        localState.workspaces.some((item) => item.id === workspaceState.activeWorkspaceId)
        ? workspaceState.activeWorkspaceId
        : localState.activeWorkspaceId;
      const nextState = {
        activeWorkspaceId: activeId,
        workspaces: localState.workspaces || [],
      };
      setWorkspaceState(nextState);
      setWorkspaceReady(true);
      const current = nextState.workspaces.find((item) => item.id === nextState.activeWorkspaceId) || nextState.workspaces[0];
      setWorkspaceNameDraft(current?.name || '');
      setWorkspaceSettingsDraft(normalizeWorkspaceSettings(current?.settings));
      applyWorkspaceLandingView(current?.settings || DEFAULT_WORKSPACE_SETTINGS);
      return nextState;
    }

    setWorkspaceLoading(true);
    try {
      const res = await authFetch(`/api/workspaces?username=${encodeURIComponent(username)}`, {}, { authToken });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to load workspaces');

      const list = Array.isArray(payload) ? payload : [];
      const ownWorkspaceId =
        list.find((item) => String(item?.owner_username || '') === username)?.id ||
        list.find((item) => item?.is_owner)?.id ||
        '';
      const candidateId =
        preferredWorkspaceId ||
        (preserveActive ? workspaceState?.activeWorkspaceId || '' : '') ||
        ownWorkspaceId;
      const hasCandidate = list.some((item) => item.id === candidateId);
      const activeId = hasCandidate ? candidateId : (ownWorkspaceId || list[0]?.id || '');
      const nextState = {
        activeWorkspaceId: activeId,
        workspaces: list,
      };
      setWorkspaceState(nextState);
      setWorkspaceReady(true);
      const current = list.find((item) => item.id === activeId) || list[0] || null;
      setWorkspaceNameDraft(current?.name || '');
      setWorkspaceSettingsDraft(normalizeWorkspaceSettings(current?.settings));
      applyWorkspaceLandingView(current?.settings || DEFAULT_WORKSPACE_SETTINGS);
      return nextState;
    } catch (err) {
      console.error('Failed to refresh workspaces', err);
      return workspaceState;
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const handleOpenWebsiteNotification = async (notification) => {
    const sharedToken = extractSharedTokenFromNotification(notification);
    if (sharedToken) {
      setWorkspaceMenuOpen(false);
      setMobileSidebarOpen(false);
      setWorkspaceSettingsOpen(false);
      setWorkspaceInviteOpen(false);
      setAccountManagerOpen(false);
      setWorkspaceManagerOpen(false);
      setTrashModalOpen(false);
      navigate(`/shared/${encodeURIComponent(sharedToken)}`, {
        state: {
          fromMessages: true,
          returnToMessages: true,
          messagesTab: 'site',
        },
      });
      return true;
    }

    const workspaceId = extractWorkspaceIdFromNotification(notification);
    if (!workspaceId) return false;

    const nextState = await refreshWorkspaces({
      preserveActive: false,
      preferredWorkspaceId: workspaceId,
    });
    const targetWorkspace = (nextState?.workspaces || []).find(
      (workspace) => workspace?.id === workspaceId
    );
    if (!targetWorkspace) {
      showToast('This workspace is no longer available to this account.', 'warning');
      return true;
    }

    setWorkspaceMenuOpen(false);
    setMobileSidebarOpen(false);
    setWorkspaceSettingsOpen(false);
    setAccountManagerOpen(false);
    setWorkspaceManagerOpen(false);
    setTrashModalOpen(false);
    setShowFiles(true);

    if (shouldOpenWorkspaceAccessPanel(notification)) {
      setWorkspaceInviteDraft('');
      setLatestInviteDelivery(null);
      setWorkspaceInviteOpen(true);
    } else {
      setWorkspaceInviteOpen(false);
    }

    return true;
  };

  const handleFriendFileShareAccepted = async (result = {}) => {
    const targetWorkspaceId = String(result.workspace_id || result.workspaceId || '').trim();
    if (targetWorkspaceId) {
      forceFilesViewAfterWorkspaceChangeRef.current = true;
    }
    setWorkspaceMenuOpen(false);
    setMobileSidebarOpen(false);
    setWorkspaceSettingsOpen(false);
    setWorkspaceInviteOpen(false);
    setAccountManagerOpen(false);
    setWorkspaceManagerOpen(false);
    setTrashModalOpen(false);
    setDocumentsPage(1);
    try {
      if (targetWorkspaceId) {
        await refreshWorkspaces({
          preserveActive: false,
          preferredWorkspaceId: targetWorkspaceId,
        });
      }
      setShowFiles(true);
      if (!targetWorkspaceId || targetWorkspaceId === activeWorkspaceId) {
        await fetchDocuments(1);
      }
      showToast(result?.warning || 'File added to your files.', result?.warning ? 'warning' : 'success');
    } catch (err) {
      console.warn('File share accepted, but the file list could not refresh', err);
      showToast('File added. Refresh Notes if it does not appear right away.', 'warning');
    }
  };

  useEffect(() => {
    const workspaceId = String(activeWorkspace?.id || '').trim();
    const canRefreshInvites =
      workspaceInviteOpen &&
      isLoggedIn &&
      username &&
      authToken &&
      workspaceId &&
      activeWorkspace?.is_owner !== false;

    if (!canRefreshInvites) return undefined;

    let stopped = false;

    const refreshOpenInvitations = async () => {
      try {
        const res = await authFetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
          {},
          { authToken }
        );
        const payload = await res.json().catch(() => []);
        if (!res.ok) throw new Error(payload.error || 'Failed to refresh invitations');
        if (stopped || !Array.isArray(payload)) return;

        const openInvites = payload.filter((item) =>
          ['pending', 'requested'].includes(String(item?.status || '').toLowerCase())
        );
        const pendingRequests = openInvites.filter(
          (item) => String(item?.status || '').toLowerCase() === 'requested'
        );
        let memberPatch = {};

        try {
          const workspaceRes = await authFetch(
            `/api/workspaces?username=${encodeURIComponent(username)}`,
            {},
            { authToken }
          );
          const workspacePayload = await workspaceRes.json().catch(() => []);
          if (workspaceRes.ok && Array.isArray(workspacePayload)) {
            const refreshedWorkspace = workspacePayload.find((item) => item?.id === workspaceId);
            if (refreshedWorkspace) {
              const refreshedMembers = Array.isArray(refreshedWorkspace.members)
                ? refreshedWorkspace.members
                : [];
              const refreshedMemberCount = Number(refreshedWorkspace.members_count);
              memberPatch = {
                members: refreshedMembers,
                members_count: Number.isFinite(refreshedMemberCount)
                  ? refreshedMemberCount
                  : refreshedMembers.length,
              };
            }
          }
        } catch (memberErr) {
          console.error('Failed to refresh workspace member snapshot', memberErr);
        }

        if (stopped) return;
        setWorkspaceState((prev) => ({
          ...prev,
          workspaces: (prev.workspaces || []).map((workspace) =>
            workspace.id === workspaceId
              ? {
                  ...workspace,
                  ...memberPatch,
                  invites: openInvites,
                  pending_requests: pendingRequests,
                }
              : workspace
          ),
        }));
      } catch (err) {
        if (!stopped) {
          console.error('Failed to refresh workspace invitations', err);
        }
      }
    };

    void refreshOpenInvitations();
    const intervalId = window.setInterval(refreshOpenInvitations, WORKSPACE_INVITE_REFRESH_MS);

    return () => {
      stopped = true;
      window.clearInterval(intervalId);
    };
  }, [
    activeWorkspace?.id,
    activeWorkspace?.is_owner,
    authToken,
    isLoggedIn,
    username,
    workspaceInviteOpen,
  ]);

  const refreshDocumentsAfterUpload = async () => {
    const shouldRefetchViaPageReset = documentsPage !== 1;
    setDocumentsPage(1);
    if (!shouldRefetchViaPageReset) {
      await fetchDocuments(1);
    }
  };

  const {
    dragUploadActive,
    uploadQueue,
    uploadQueueRunning,
    uploadQueueExpanded,
    setUploadQueueExpanded,
    fileHint,
    fileInputRef,
    uploadQueueSummary,
    canRetryFailedUploads,
    canClearUploadQueue,
    handleFileChange,
    handleUpload,
    handleUploadDragEnter,
    handleUploadDragOver,
    handleUploadDragLeave,
    handleUploadDrop,
    handleRetryFailedUploads,
    handleClearCompletedUploads,
    clearDragUploadState,
    resetUploadState,
  } = useUploadQueue({
    isLoggedIn,
    activeWorkspaceId,
    allowUploads: activeWorkspaceSettings.allow_uploads,
    uploadCategory,
    autoCategorize: activeWorkspaceSettings.auto_categorize,
    defaultCategory: activeWorkspaceSettings.default_category,
    showToast,
    showWorkspaceToast,
    onUploadsCompleted: refreshDocumentsAfterUpload,
    resetKey: `${activeWorkspaceId || ''}:${username || ''}:${authToken || ''}`,
  });

  const openUploadPicker = () => {
    if (!activeWorkspaceSettings.allow_uploads) return;
    setUploadTrayCollapsed((prev) => !prev);
  };

  useEffect(() => {
    if (dragUploadActive || uploadQueueRunning || uploadQueueSummary.failed > 0) {
      setUploadTrayCollapsed(false);
      return;
    }
    if (uploadQueueSummary.total > 0 && uploadQueueSummary.uploading === 0) {
      setUploadTrayCollapsed(true);
    }
  }, [
    dragUploadActive,
    uploadQueueRunning,
    uploadQueueSummary.failed,
    uploadQueueSummary.total,
    uploadQueueSummary.uploading,
  ]);

  const fetchTrashDocuments = async ({
    silent = false,
    targetPage = trashPage,
    targetPageSize = trashPageSize,
    query = trashQuery,
    sort = trashSort,
  } = {}) => {
    const requestSeq = trashRequestSeqRef.current + 1;
    trashRequestSeqRef.current = requestSeq;
    const commitIfLatest = (callback) => {
      if (requestSeq !== trashRequestSeqRef.current) return;
      callback();
    };
    const safePage = Math.max(1, Number(targetPage) || 1);
    const safePageSize = normalizeTrashPageSize(targetPageSize);
    const safeQuery = String(query || '').trim();
    const safeSort = normalizeTrashSort(sort);
    const offset = (safePage - 1) * safePageSize;

    if (!username || !authToken || !activeWorkspaceId) {
      commitIfLatest(() => {
        setTrashItems([]);
        setTrashTotal(0);
        setTrashRetentionDays(30);
        setTrashPurgedCount(0);
        setTrashLoading(false);
        setTrashLoadError('');
      });
      return;
    }

    commitIfLatest(() => {
      if (!silent) setTrashLoading(true);
      setTrashLoadError('');
    });

    try {
      const params = new URLSearchParams({
        username,
        limit: String(Math.min(TRASH_FETCH_LIMIT, safePageSize)),
        offset: String(Math.max(0, offset)),
        sort: safeSort,
      });
      if (safeQuery) params.set('q', safeQuery);
      if (activeWorkspaceId) params.set('workspace_id', activeWorkspaceId);
      const res = await authFetch(`/api/documents/trash?${params.toString()}`, {}, { authToken });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || 'Failed to load Trash');
      }

      const items = Array.isArray(payload?.items)
        ? payload.items.map((item) => normalizeDocument(item))
        : [];
      const total = Number(payload?.total);
      const retentionDays = Math.max(1, Number(payload?.retention_days) || 30);
      const purgedCount = Math.max(0, Number(payload?.purged_count) || 0);

      commitIfLatest(() => {
        setTrashItems(items);
        setTrashTotal(Number.isFinite(total) ? Math.max(0, total) : items.length);
        setTrashRetentionDays(retentionDays);
        setTrashPurgedCount(purgedCount);
      });
    } catch (err) {
      console.error('Failed to fetch trash documents', err);
      commitIfLatest(() => {
        setTrashItems([]);
        setTrashTotal(0);
        setTrashLoadError(err?.message || 'Failed to load Trash');
      });
    } finally {
      commitIfLatest(() => {
        setTrashLoading(false);
      });
    }
  };

  useEffect(() => {
    if (!trashModalOpen) return;
    fetchTrashDocuments();
  }, [trashModalOpen, username, authToken, activeWorkspaceId, trashPage, trashPageSize, trashQuery, trashSort]);

  useEffect(() => {
    if (!trashModalOpen) {
      setSelectedTrashDocumentIds([]);
      setTrashBulkActionLoading(false);
      return;
    }
    const currentIds = new Set(
      trashItems
        .map((item) => toPositiveDocId(item?.id))
        .filter(Boolean)
    );
    setSelectedTrashDocumentIds((prev) =>
      prev.filter((id) => currentIds.has(toPositiveDocId(id)))
    );
  }, [trashModalOpen, trashItems]);

  useEffect(() => {
    setActiveDocEditMode(false);
    setActiveDocSaveError('');
    setActiveDocDraftHtml(getDocumentRichHtml(activeDoc));
    setPdfConversionDraft(null);
    setPdfConversionChoiceOpen(false);
    setPdfConversionLoading(false);
    setPdfConversionMode('simple');
    setPdfConversionOutputFormat('docx');
    setPdfConversionSaveMode('replace');
    setPdfConversionTitle('');
  }, [activeDoc?.id, activeDoc?.content, activeDoc?.contentHtml]);

  useEffect(() => {
    clearActiveDocShareState();
  }, [activeDoc?.id, activeWorkspaceId, username, workspaceReady]);

  useEffect(() => {
    resetDocumentsData();
    setSelectedDocumentIds([]);
    setSelectAllMatchedLoading(false);
    setBulkCategoryDraft('');
    setBulkTagsDraft('');
    setBulkResultSummary(DEFAULT_BULK_RESULT_SUMMARY);
    setTrashItems([]);
    setTrashTotal(0);
    setTrashPurgedCount(0);
    setTrashLoadError('');
    setTrashLoading(false);
    setTrashActionLoadingId('');
    setSelectedTrashDocumentIds([]);
    setTrashBulkActionLoading(false);
    setTrashPage(1);
    setTrashPageSize(TRASH_PAGE_SIZE_OPTIONS[1]);
    setTrashSort('deleted_newest');
    setTrashQuery('');
    resetUploadState();
  }, [activeWorkspaceId, username, authToken]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (forceFilesViewAfterWorkspaceChangeRef.current) {
      forceFilesViewAfterWorkspaceChangeRef.current = false;
      setShowFiles(true);
      return;
    }
    applyWorkspaceLandingView(activeWorkspace?.settings || DEFAULT_WORKSPACE_SETTINGS);
  }, [activeWorkspaceId]);

  useEffect(() => {
    setSummaryResultOpen(false);
    setSummaryResultTitle('');
    setOcrResultOpen(false);
    setOcrSourceContext(null);
    setOcrSaveFormat('txt');
    setExtractedText('');
    setAnalysisResult(null);
  }, [activeWorkspaceId]);

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [activeWorkspaceId, showFiles, docPaneVisible, isLoggedIn]);

  useEffect(() => {
    if (!location.state?.showFiles) return;
    if (
      preferredWorkspaceIdFromNavigation &&
      activeWorkspaceId &&
      activeWorkspaceId !== preferredWorkspaceIdFromNavigation
    ) {
      return;
    }
    setShowFiles(true);
  }, [activeWorkspaceId, location.state?.showFiles, preferredWorkspaceIdFromNavigation]);

  useEffect(() => {
    if (!location.state?.reopenMessages) return;
    const requestedTab = String(location.state?.messagesTab || 'site').trim();
    setMessagesOpenRequest((prev) => ({
      key: prev.key + 1,
      tab: ['friends', 'requests', 'site'].includes(requestedTab) ? requestedTab : 'site',
    }));
  }, [location.key, location.state?.messagesTab, location.state?.reopenMessages]);

  useEffect(() => {
    const handleStorage = () => {
      const nextSession = readStoredAuthSession();
      setIsLoggedIn(nextSession.isAuthenticated);
      if (nextSession.preferences) {
        setUserNotificationPreferences(
          normalizeUserNotificationPreferences(nextSession.preferences)
        );
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    if (!authToken) {
      setUserNotificationPreferences(DEFAULT_USER_NOTIFICATION_PREFERENCES);
      return undefined;
    }

    let cancelled = false;
    authFetch('/api/auth/me', {}, { authToken })
      .then(async (res) => {
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || 'Failed to load account preferences');
        if (!cancelled) {
          setUserNotificationPreferences(
            normalizeUserNotificationPreferences(payload.preferences || payload)
          );
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn(error?.message || 'Failed to load account preferences');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authToken]);

  useEffect(() => {
    const handleAuthExpired = (event) => {
      const message = String(event?.detail?.message || '').trim();
      setIsLoggedIn(false);
      resetDocumentsData();
      setSidebarRecentIds([]);
      setSidebarRecentMeta({});
      setStarredNotes([]);
      setSummaryHistory([]);
      setSummaryCenterOpen(false);
      setSummaryCenterQuery('');
      setSummaryCenterModel('all');
      setSummaryCenterChunk('all');
      setSummaryProgress(DEFAULT_SUMMARY_PROGRESS);
      setSidebarMenuDocId(null);
      setActiveDoc(null);
      setActiveDocError('');
      setActiveDocLoading(false);
      setActiveDocFileVersion(0);
      setActiveDocEditMode(false);
      setActiveDocDraftHtml('');
      setActiveDocSaveError('');
      clearActiveDocShareState();
      setShowFiles(false);
      setSummaryResultOpen(false);
      setSummaryResultTitle('');
      setOcrResultOpen(false);
      setOcrSourceContext(null);
      setOcrSaveFormat('txt');
      setExtractedText('');
      setAnalysisResult(null);
      setTrashModalOpen(false);
      setTrashItems([]);
      setTrashTotal(0);
      setTrashPurgedCount(0);
      setTrashLoadError('');
      setTrashLoading(false);
      setTrashActionLoadingId('');
      setSelectedTrashDocumentIds([]);
      setTrashBulkActionLoading(false);
      setTrashPage(1);
      setTrashPageSize(TRASH_PAGE_SIZE_OPTIONS[1]);
      setTrashSort('deleted_newest');
      setTrashQuery('');
      resetUploadState();
      if (summaryProgressTimerRef.current) {
        window.clearTimeout(summaryProgressTimerRef.current);
        summaryProgressTimerRef.current = null;
      }
      setWorkspaceMenuOpen(false);
      closeWorkspaceDialogs();
      if (message) showToast(message, 'warning');
    };
    window.addEventListener('studyhub-auth-expired', handleAuthExpired);
    return () => window.removeEventListener('studyhub-auth-expired', handleAuthExpired);
  }, []);

  useEffect(() => {
    const normalized = normalizeAccounts(savedAccounts);
    if (
      normalized.length !== savedAccounts.length ||
      normalized.some((item, idx) => {
        const original = savedAccounts[idx];
        return (
          !original ||
          original.username !== item.username ||
          original.email !== item.email ||
          original.lastActiveAt !== item.lastActiveAt
        );
      })
    ) {
      setSavedAccounts(normalized);
      return;
    }
    persistAccountHistory(
      normalized.map((item) => ({
        username: item.username,
        email: item.email,
        lastLogin: item.lastActiveAt || new Date().toISOString(),
      }))
    );
  }, [savedAccounts]);

  useEffect(() => {
    setWorkspaceReady(!(isLoggedIn && username && authToken));
    refreshWorkspaces({
      preserveActive: false,
      preferredWorkspaceId: preferredWorkspaceIdFromNavigation,
    });
    setWorkspaceInviteDraft('');
    setLatestInviteDelivery(null);
    setWorkspaceSettingsOpen(false);
    setWorkspaceInviteOpen(false);
    setAccountManagerOpen(false);
    setWorkspaceManagerOpen(false);
    setTrashModalOpen(false);
  }, [accountName, isLoggedIn, username, authToken, preferredWorkspaceIdFromNavigation]);

  useEffect(() => {
    const nextViews = loadSavedViews(accountName, activeWorkspaceId);
    setSavedViews(nextViews);
    setActiveSavedViewId('');
  }, [accountName, activeWorkspaceId]);

  useEffect(() => {
    const nextRecent = loadRecentNotes(accountName, activeWorkspaceId);
    setSidebarRecentIds(nextRecent.map((item) => toPositiveDocId(item.id)).filter(Boolean));
    setSidebarRecentMeta(
      nextRecent.reduce((acc, item) => {
        const id = toPositiveDocId(item.id);
        if (!id) return acc;
        acc[id] = item;
        return acc;
      }, {})
    );
  }, [accountName, activeWorkspaceId]);

  useEffect(() => {
    const nextStarred = loadStarredNotes(accountName, activeWorkspaceId);
    setStarredNotes(nextStarred);
    setStarredDragId(0);
  }, [accountName, activeWorkspaceId]);

  useEffect(() => {
    if (summaryProgressTimerRef.current) {
      window.clearTimeout(summaryProgressTimerRef.current);
      summaryProgressTimerRef.current = null;
    }
    setSummaryProgress(DEFAULT_SUMMARY_PROGRESS);
    const nextHistory = loadSummaryHistory(accountName, activeWorkspaceId);
    setSummaryHistory(nextHistory);
    setSummaryCenterQuery('');
    setSummaryCenterSort('newest');
    setSummaryCenterSource('all');
    setSummaryCenterModel('all');
    setSummaryCenterChunk('all');
    setSummaryCenterExpandedIds([]);
    setSummaryCenterActionId('');
    setSummaryCenterOpen(false);
  }, [accountName, activeWorkspaceId]);

  useEffect(() => {
    persistSavedViews(accountName, activeWorkspaceId, savedViews);
  }, [accountName, activeWorkspaceId, savedViews]);

  useEffect(() => {
    const entries = sidebarRecentIds
      .map((id) => {
        const safeId = toPositiveDocId(id);
        if (!safeId) return null;
        const meta = sidebarRecentMeta[safeId] || {};
        return normalizeRecentNoteEntry({
          id: safeId,
          title: meta.title || `Note ${safeId}`,
          fileType: meta.fileType || '',
          updatedAt: meta.updatedAt || '',
        });
      })
      .filter(Boolean);
    persistRecentNotes(accountName, activeWorkspaceId, entries);
  }, [accountName, activeWorkspaceId, sidebarRecentIds, sidebarRecentMeta]);

  useEffect(() => {
    persistStarredNotes(accountName, activeWorkspaceId, starredNotes);
  }, [accountName, activeWorkspaceId, starredNotes]);

  useEffect(() => {
    persistSummaryHistory(accountName, activeWorkspaceId, summaryHistory);
  }, [accountName, activeWorkspaceId, summaryHistory]);

  useEffect(() => {
    const idSet = new Set(summaryHistory.map((item) => String(item.id)));
    setSummaryCenterExpandedIds((prev) => prev.filter((id) => idSet.has(String(id))));
    setSummaryCenterActionId((prev) => (idSet.has(String(prev)) ? prev : ''));
  }, [summaryHistory]);

  useEffect(() => {
    if (!documents.length) return;
    setSidebarRecentMeta((prev) => {
      if (!prev || typeof prev !== 'object') return prev;
      const next = { ...prev };
      let changed = false;
      documents.forEach((doc) => {
        const id = toPositiveDocId(doc.id);
        if (!id || !next[id]) return;
        const nextTitle = String(doc.title || '').trim() || next[id].title || `Note ${id}`;
        const nextFileType = String(getDocExt(doc) || '').trim().toLowerCase();
        if (nextTitle !== next[id].title || nextFileType !== next[id].fileType) {
          next[id] = {
            ...next[id],
            title: nextTitle,
            fileType: nextFileType,
            updatedAt: new Date().toISOString(),
          };
          changed = true;
        }
      });
      return changed ? next : prev;
    });

    setStarredNotes((prev) => {
      if (!prev.length) return prev;
      const docMap = new Map(
        documents
          .map((doc) => [toPositiveDocId(doc.id), doc])
          .filter(([id]) => id > 0)
      );
      let changed = false;
      const next = prev.map((entry) => {
        const doc = docMap.get(toPositiveDocId(entry.id));
        if (!doc) return entry;
        const nextTitle = String(doc.title || '').trim() || entry.title;
        const nextFileType = String(getDocExt(doc) || '').trim().toLowerCase();
        if (nextTitle !== entry.title || nextFileType !== entry.fileType) {
          changed = true;
          return {
            ...entry,
            title: nextTitle,
            fileType: nextFileType,
            updatedAt: new Date().toISOString(),
          };
        }
        return entry;
      });
      return changed ? next : prev;
    });
  }, [documents]);

  useEffect(() => {
    if (workspaceSettingsOpen || workspaceInviteOpen) return;
    setWorkspaceNameDraft(activeWorkspace?.name || `${accountName}'s Workspace`);
    setWorkspaceSettingsDraft(activeWorkspaceSettings);
  }, [
    activeWorkspaceId,
    activeWorkspace?.name,
    activeWorkspaceSettings,
    workspaceInviteOpen,
    workspaceSettingsOpen,
    accountName,
  ]);

  useEffect(() => {
    if (isLoggedIn) return;
    persistWorkspaceState(accountName, workspaceState);
  }, [accountName, workspaceState, isLoggedIn]);

  useEffect(() => {
    if (!username) return;
    const nextAccounts = upsertAccount(savedAccounts, {
      username,
      email: accountEmail,
      lastActiveAt: new Date().toISOString(),
    });
    setSavedAccounts((prev) => {
      if (
        prev.length === nextAccounts.length &&
        prev.every(
          (item, idx) =>
            item.username === nextAccounts[idx].username &&
            item.email === nextAccounts[idx].email &&
            item.lastActiveAt === nextAccounts[idx].lastActiveAt
        )
      ) {
        return prev;
      }
      return nextAccounts;
    });
  }, [username, accountEmail]);

  useEffect(() => {
    let timer = null;
    const tick = () => {
      setNow(new Date());
      const delay = 1000 - (Date.now() % 1000);
      timer = window.setTimeout(tick, delay);
    };
    tick();
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    document.body.classList.add('notion-home-body');
    return () => document.body.classList.remove('notion-home-body');
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      if (typeof confirmResolverRef.current === 'function') {
        confirmResolverRef.current(false);
        confirmResolverRef.current = null;
      }
      if (typeof inputDialogResolverRef.current === 'function') {
        inputDialogResolverRef.current(null);
        inputDialogResolverRef.current = null;
      }
      if (summaryProgressTimerRef.current) {
        window.clearTimeout(summaryProgressTimerRef.current);
        summaryProgressTimerRef.current = null;
      }
      clearDragUploadState();
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(event.target)) {
        setWorkspaceMenuOpen(false);
      }
      if (recentMenuRef.current && !recentMenuRef.current.contains(event.target)) {
        setSidebarMenuDocId(null);
      }
      if (savedViewsMenuRef.current && !savedViewsMenuRef.current.contains(event.target)) {
        setSavedViewsMenuOpen(false);
      }
    };
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setWorkspaceMenuOpen(false);
        setSidebarMenuDocId(null);
        setSavedViewsMenuOpen(false);
        setWorkspaceSettingsOpen(false);
        setWorkspaceInviteOpen(false);
        setAccountManagerOpen(false);
        setWorkspaceManagerOpen(false);
        setTrashModalOpen(false);
        clearDragUploadState();
        if (inputDialogState.open) {
          closeInputDialog(false);
        }
        if (confirmDialogState.open) {
          closeConfirmDialog(false);
        }
      }
    };

    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [confirmDialogState.open, inputDialogState.open]);

  useEffect(() => {
    const startSession = () => {
      sessionStartRef.current = Date.now();
    };
    const stopSession = () => {
      if (!sessionStartRef.current) return;
      const deltaSec = Math.max(0, Math.round((Date.now() - sessionStartRef.current) / 1000));
      sessionStartRef.current = null;
      if (!deltaSec) return;
      setUsageMap((prev) => {
        const next = { ...prev };
        const key = todayKey();
        next[key] = (next[key] || 0) + deltaSec;
        persistUsageMap(next);
        return next;
      });
    };

    if (document.visibilityState === 'visible') startSession();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') startSession();
      else stopSession();
    };

    const handleBeforeUnload = () => stopSession();
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      stopSession();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  const trashPageCount = useMemo(
    () =>
      Math.max(
        1,
        Math.ceil((Number(trashTotal) || 0) / normalizeTrashPageSize(trashPageSize))
      ),
    [trashTotal, trashPageSize]
  );
  const trashRangeStart = useMemo(() => {
    if (!trashTotal) return 0;
    return (Math.max(1, Number(trashPage) || 1) - 1) * normalizeTrashPageSize(trashPageSize) + 1;
  }, [trashTotal, trashPage, trashPageSize]);
  const trashRangeEnd = useMemo(
    () => Math.min(Number(trashTotal) || 0, trashRangeStart + normalizeTrashPageSize(trashPageSize) - 1),
    [trashTotal, trashRangeStart, trashPageSize]
  );

  useEffect(() => {
    if (trashPage <= trashPageCount) return;
    setTrashPage(trashPageCount);
  }, [trashPage, trashPageCount]);
  const dashboardStats = useMemo(() => {
    const tagBag = new Set();
    const categoryBag = new Set();
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let recentUploads = 0;

    documents.forEach((doc) => {
      (doc.tags || []).forEach((tag) => tagBag.add(tag));
      categoryBag.add(normalizeCategory(doc.category));

      const uploadedMs = toTimeMs(doc.uploadedAt);
      if (uploadedMs >= sevenDaysAgo) recentUploads += 1;
    });

    return {
      total: Number(documentsTotal) || documents.length,
      categories: categoryBag.size,
      tags: tagBag.size,
      recentUploads,
    };
  }, [documents, documentsTotal]);
  useEffect(() => {
    if (!savedViews.length) {
      if (activeSavedViewId) setActiveSavedViewId('');
      return;
    }
    const matched = savedViews.find((view) => viewMatchesSnapshot(view, currentViewSnapshot));
    const nextActiveId = matched?.id || '';
    if (nextActiveId !== activeSavedViewId) {
      setActiveSavedViewId(nextActiveId);
    }
  }, [savedViews, currentViewSnapshot, activeSavedViewId]);
  const selectedDocumentIdSet = useMemo(
    () =>
      new Set(
        selectedDocumentIds
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id))
      ),
    [selectedDocumentIds]
  );
  const visibleDocumentIds = useMemo(
    () =>
      filteredDocuments
        .map((doc) => Number(doc.id))
        .filter((id) => Number.isFinite(id)),
    [filteredDocuments]
  );
  const visibleDocumentIdSet = useMemo(() => new Set(visibleDocumentIds), [visibleDocumentIds]);
  const selectedDocumentCount = selectedDocumentIds.length;
  const activeSavedView = useMemo(
    () => savedViews.find((item) => item.id === activeSavedViewId) || null,
    [savedViews, activeSavedViewId]
  );
  const selectedOnCurrentPageCount = useMemo(
    () => visibleDocumentIds.filter((id) => selectedDocumentIdSet.has(id)).length,
    [visibleDocumentIds, selectedDocumentIdSet]
  );
  const selectedOutsideCurrentPageCount = Math.max(0, selectedDocumentCount - selectedOnCurrentPageCount);
  const allDocumentsSelectedOnPage =
    visibleDocumentIds.length > 0 &&
    visibleDocumentIds.every((id) => selectedDocumentIdSet.has(id));
  const canResetFilesView =
    Boolean(searchDraft.trim()) ||
    Boolean(filters.query || filters.start || filters.end || filters.tag || filters.category || filters.fileType) ||
    normalizeDocumentsSort(documentsSort) !== DEFAULT_DOCUMENTS_SORT ||
    normalizeDocumentsPageSize(documentsPageSize) !== DEFAULT_DOCUMENTS_PAGE_SIZE ||
    normalizeDocumentsLayout(documentsLayout) !== DEFAULT_DOCUMENTS_LAYOUT ||
    documentsPage !== 1 ||
    selectedDocumentCount > 0 ||
    Boolean(activeSavedViewId);
  const trashSelectedIdSet = useMemo(
    () =>
      new Set(
        selectedTrashDocumentIds
          .map((id) => toPositiveDocId(id))
          .filter(Boolean)
      ),
    [selectedTrashDocumentIds]
  );
  const selectedTrashCount = selectedTrashDocumentIds.length;
  const allTrashItemsSelectedOnPage =
    trashItems.length > 0 &&
    trashItems.every((item) => trashSelectedIdSet.has(toPositiveDocId(item?.id)));

  const formatDisplayDate = (value) => formatDisplayDateValue(value);

  const sidebarDocs = useMemo(() => {
    const byId = new Map(documents.map((doc) => [Number(doc.id), doc]));
    return sidebarRecentIds
      .map((id) => {
        const safeId = toPositiveDocId(id);
        const matched = byId.get(safeId);
        if (matched) return matched;
        const meta = sidebarRecentMeta[safeId] || {};
        return {
          id: safeId,
          title: String(meta.title || `Note ${safeId}`),
          uploadedAt: meta.updatedAt || '',
          tags: [],
          category: '',
        };
      })
      .filter((item) => toPositiveDocId(item?.id) > 0)
      .slice(0, activeRecentLimit);
  }, [documents, sidebarRecentIds, sidebarRecentMeta, activeRecentLimit]);
  useEffect(() => {
    setSidebarRecentIds((prev) => prev.slice(0, activeRecentLimit));
  }, [activeRecentLimit]);
  useEffect(() => {
    setSidebarRecentMeta((prev) => {
      if (!prev || typeof prev !== 'object') return {};
      const keep = new Set(sidebarRecentIds.map((id) => toPositiveDocId(id)).filter(Boolean));
      const keys = Object.keys(prev);
      if (!keys.length) return prev;
      let changed = false;
      const next = {};
      keys.forEach((key) => {
        const id = toPositiveDocId(key);
        if (!id || !keep.has(id)) {
          changed = true;
          return;
        }
        next[id] = prev[key];
      });
      return changed ? next : prev;
    });
  }, [sidebarRecentIds]);
  const sidebarStarredDocs = useMemo(
    () => starredNotes.slice(0, Math.max(activeRecentLimit, 8)),
    [starredNotes, activeRecentLimit]
  );
  const activeDocIsStarred = useMemo(
    () => (activeDoc ? starredDocIdSet.has(toPositiveDocId(activeDoc.id)) : false),
    [activeDoc, starredDocIdSet]
  );

  const nowLabel = useMemo(
    () =>
      `@Today ${now.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })}`,
    [now]
  );

  const closeWorkspaceDialogs = () => {
    setWorkspaceSettingsOpen(false);
    setWorkspaceInviteOpen(false);
    setAccountManagerOpen(false);
    setWorkspaceManagerOpen(false);
    setLatestInviteDelivery(null);
  };

  const openWorkspaceSettingsPanel = () => {
    if (isLoggedIn && activeWorkspace?.is_owner === false) {
      setWorkspaceManagerOpen(true);
      setWorkspaceSettingsOpen(false);
      setWorkspaceInviteOpen(false);
      setAccountManagerOpen(false);
      setWorkspaceMenuOpen(false);
      return;
    }
    setWorkspaceNameDraft(activeWorkspace?.name || `${accountName}'s Workspace`);
    setWorkspaceSettingsDraft(normalizeWorkspaceSettings(activeWorkspace?.settings));
    setWorkspaceSettingsTab('general');
    setWorkspaceSettingsOpen(true);
    setWorkspaceInviteOpen(false);
    setAccountManagerOpen(false);
    setWorkspaceManagerOpen(false);
    setWorkspaceMenuOpen(false);
  };

  const openWorkspaceInvitePanel = () => {
    setWorkspaceNameDraft(activeWorkspace?.name || `${accountName}'s Workspace`);
    setWorkspaceSettingsDraft(normalizeWorkspaceSettings(activeWorkspace?.settings));
    setWorkspaceInviteOpen(true);
    setWorkspaceSettingsOpen(false);
    setAccountManagerOpen(false);
    setWorkspaceManagerOpen(false);
    setWorkspaceMenuOpen(false);
  };

  const getDefaultActiveDocShareExpiryDays = () =>
    String(clamp(Number(activeWorkspaceSettings.default_share_expiry_days) || 7, 1, 30));

  const resetActiveDocShareEmailDraft = () => {
    setActiveDocShareEmailRecipient('');
    setActiveDocShareEmailMessage('');
    setActiveDocShareEmailExpiryDays(getDefaultActiveDocShareExpiryDays());
    setActiveDocShareEmailResult(null);
  };

  const clearActiveDocShareState = () => {
    setActiveDocShareLinks([]);
    setActiveDocShareLinksLoading(false);
    setActiveDocShareLinksError('');
    setActiveDocShareActionLoadingId(0);
    setActiveDocShareActionLoadingType('');
    setActiveDocShareEmailOpen(false);
    setActiveDocShareModalMode('send');
    setActiveDocShareEmailSending(false);
    resetActiveDocShareEmailDraft();
  };

  const removeDocumentFromClientState = (docId) => {
    const removedId = toPositiveDocId(docId);
    if (!removedId) return;
    setDocuments((prev) => prev.filter((item) => toPositiveDocId(item.id) !== removedId));
    setSidebarRecentIds((prev) => prev.filter((id) => toPositiveDocId(id) !== removedId));
    setSidebarRecentMeta((prev) => {
      const next = { ...(prev || {}) };
      delete next[removedId];
      return next;
    });
    setStarredNotes((prev) => prev.filter((item) => toPositiveDocId(item.id) !== removedId));
    setSummaryHistory((prev) => prev.filter((item) => toPositiveDocId(item.docId) !== removedId));
    setSelectedDocumentIds((prev) => prev.filter((id) => toPositiveDocId(id) !== removedId));
    if (toPositiveDocId(activeDoc?.id) === removedId) {
      clearActiveDocShareState();
      setActiveDoc(null);
    }
  };

  const updateWorkspaceSettingsDraft = (patch) => {
    setWorkspaceSettingsDraft((prev) => {
      const merged = {
        ...prev,
        ...(typeof patch === 'function' ? patch(prev) : patch),
      };
      return normalizeWorkspaceSettings(merged);
    });
  };

  const applyWorkspaceLandingView = (rawSettings) => {
    const settings = normalizeWorkspaceSettings(rawSettings);
    setDocumentsLayout(normalizeDocumentsLayout(settings.default_documents_layout));
    setDocumentsSort(normalizeDocumentsSort(settings.default_documents_sort));
    setDocumentsPageSize(normalizeDocumentsPageSize(settings.default_documents_page_size));
    setDocumentsPage(1);
    setShowFiles(settings.default_home_tab === 'files');
  };

  const handleSignOut = ({ forgetCurrent = false } = {}) => {
    const currentUsername = sessionStorage.getItem('username') || '';
    const currentAuthToken = sessionStorage.getItem('auth_token') || '';
    clearStoredAuthSession();
    void logoutCurrentSession(currentAuthToken);
    setIsLoggedIn(false);
    resetDocumentsData();
    setSidebarRecentIds([]);
    setSidebarRecentMeta({});
    setStarredNotes([]);
    setSummaryHistory([]);
    setSummaryCenterOpen(false);
    setSummaryCenterQuery('');
    setSidebarMenuDocId(null);
    setActiveDoc(null);
    setActiveDocError('');
    setActiveDocLoading(false);
    setActiveDocFileVersion(0);
    setActiveDocEditMode(false);
    setActiveDocDraftHtml('');
    setActiveDocSaveError('');
    clearActiveDocShareState();
    setShowFiles(false);
    setSummaryResultOpen(false);
    setSummaryResultTitle('');
    setOcrResultOpen(false);
    setOcrSourceContext(null);
    setOcrSaveFormat('txt');
    setExtractedText('');
    setAnalysisResult(null);
    setTrashModalOpen(false);
    setTrashItems([]);
    setTrashTotal(0);
    setTrashPurgedCount(0);
    setTrashLoadError('');
    setTrashLoading(false);
    setTrashActionLoadingId('');
    setSelectedTrashDocumentIds([]);
    setTrashBulkActionLoading(false);
    setTrashPage(1);
    setTrashPageSize(TRASH_PAGE_SIZE_OPTIONS[1]);
    setTrashSort('deleted_newest');
    setTrashQuery('');
    resetUploadState();
    setWorkspaceMenuOpen(false);
    closeWorkspaceDialogs();

    if (forgetCurrent && currentUsername) {
      const nextHistory = removeAccountFromHistory(currentUsername);
      setSavedAccounts(normalizeAccounts(nextHistory));
    }
  };

  const handleSwitchAccount = (account) => {
    const target = normalizeAccountRecord(account);
    if (!target) return;
    const nextHistory = saveAccountToHistory({
      username: target.username,
      email: target.email,
    });
    setSavedAccounts(normalizeAccounts(nextHistory));
    handleSignOut();
    navigate('/login', {
      state: {
        prefillUsername: target.username,
        prefillEmail: target.email || '',
        fromAccountSwitch: true,
      },
    });
  };

  const handleCreateWorkspace = async () => {
    const proposedName = await requestTextInput({
      title: 'Create Workspace',
      description: 'Enter a workspace name.',
      placeholder: `${accountName}'s Workspace`,
      initialValue: `${accountName}'s Workspace`,
      confirmLabel: 'Create',
      cancelLabel: 'Cancel',
      trimResult: true,
    });
    if (proposedName === null) return;
    const nextName = proposedName.trim() || `${accountName}'s Workspace`;

    if (isLoggedIn && username) {
      setWorkspaceActionLoading(true);
      try {
        const res = await authFetch('/api/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, name: nextName }),
        }, { authToken });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || 'Failed to create workspace');
        await refreshWorkspaces({ preferredWorkspaceId: payload.id, preserveActive: false });
        resetDocumentsData();
        setSidebarRecentIds([]);
        setSidebarRecentMeta({});
        setStarredNotes([]);
        setSummaryHistory([]);
        setSummaryCenterOpen(false);
        setSummaryCenterQuery('');
        setSidebarMenuDocId(null);
        setActiveDoc(null);
        setActiveDocError('');
        setActiveDocLoading(false);
        setActiveDocFileVersion(0);
        setActiveDocEditMode(false);
        setActiveDocDraftHtml('');
        setActiveDocSaveError('');
        clearActiveDocShareState();
        setLatestInviteDelivery(null);
        applyWorkspaceLandingView(DEFAULT_WORKSPACE_SETTINGS);
      } catch (err) {
        showToast(err.message || 'Failed to create workspace', 'error');
      } finally {
        setWorkspaceActionLoading(false);
      }
      return;
    }

    const nextWorkspace = createWorkspace(accountName, {
      name: nextName,
      members: [accountName],
    });
    setWorkspaceState((prev) => {
      const current = prev?.workspaces?.length ? prev : loadWorkspaceState(accountName);
      return {
        activeWorkspaceId: nextWorkspace.id,
        workspaces: [nextWorkspace, ...current.workspaces],
      };
    });
    resetDocumentsData();
    setSidebarRecentIds([]);
    setSidebarRecentMeta({});
    setStarredNotes([]);
    setSummaryHistory([]);
    setSummaryCenterOpen(false);
    setSummaryCenterQuery('');
    setSidebarMenuDocId(null);
    setActiveDoc(null);
    setActiveDocError('');
    setActiveDocLoading(false);
    setActiveDocFileVersion(0);
    setActiveDocEditMode(false);
    setActiveDocDraftHtml('');
    setActiveDocSaveError('');
    clearActiveDocShareState();
    setLatestInviteDelivery(null);
    applyWorkspaceLandingView(nextWorkspace.settings || DEFAULT_WORKSPACE_SETTINGS);
  };

  const handleSelectWorkspace = (workspaceId) => {
    const targetId = String(workspaceId || '');
    if (!targetId) return;
    const targetWorkspace = (workspaceState?.workspaces || []).find((item) => item.id === targetId) || null;
    setWorkspaceMenuOpen(false);
    setWorkspaceState((prev) => {
      if (!prev?.workspaces?.some((item) => item.id === targetId)) return prev;
      return {
        ...prev,
        activeWorkspaceId: targetId,
      };
    });
    resetDocumentsData();
    setSidebarRecentIds([]);
    setSidebarRecentMeta({});
    setStarredNotes([]);
    setSummaryHistory([]);
    setSummaryCenterOpen(false);
    setSummaryCenterQuery('');
    setSidebarMenuDocId(null);
    setActiveDoc(null);
    setActiveDocError('');
    setActiveDocLoading(false);
    setActiveDocFileVersion(0);
    setActiveDocEditMode(false);
    setActiveDocDraftHtml('');
    setActiveDocSaveError('');
    clearActiveDocShareState();
    setLatestInviteDelivery(null);
    applyWorkspaceLandingView(targetWorkspace?.settings || DEFAULT_WORKSPACE_SETTINGS);
  };

  const handleSaveWorkspaceSettings = (options = {}) => {
    const {
      closeSettings = true,
      closeInvite = false,
      successMessage = 'Workspace settings saved.',
    } = options || {};
    if (!activeWorkspace) return;
    const nextName = workspaceNameDraft.trim();
    if (!nextName) {
      showToast('Workspace name cannot be empty.', 'warning');
      return;
    }
    const nextSettings = normalizeWorkspaceSettings(workspaceSettingsDraft);
    if (isLoggedIn && username) {
      setWorkspaceActionLoading(true);
      authFetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          name: nextName,
          settings: nextSettings,
        }),
      }, { authToken })
        .then(async (res) => {
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(payload.error || 'Failed to save workspace settings');
          await refreshWorkspaces({ preferredWorkspaceId: activeWorkspace.id });
          applyWorkspaceLandingView(nextSettings);
          if (closeSettings) setWorkspaceSettingsOpen(false);
          if (closeInvite) setWorkspaceInviteOpen(false);
          showToast(successMessage, 'success');
        })
        .catch((err) => {
          showToast(err.message || 'Failed to save workspace settings', 'error');
        })
        .finally(() => setWorkspaceActionLoading(false));
      return;
    }
    setWorkspaceState((prev) => ({
      ...prev,
      workspaces: prev.workspaces.map((item) =>
        item.id === activeWorkspace.id
          ? {
              ...item,
              name: nextName,
              settings: nextSettings,
            }
          : item
      ),
    }));
    applyWorkspaceLandingView(nextSettings);
    if (closeSettings) setWorkspaceSettingsOpen(false);
    if (closeInvite) setWorkspaceInviteOpen(false);
    showToast(successMessage, 'success');
  };

  const handleSaveWorkspaceAccessSettings = () => {
    handleSaveWorkspaceSettings({
      closeSettings: false,
      closeInvite: false,
      successMessage: 'Workspace access settings saved.',
    });
  };

  const handleInviteMembers = async () => {
    if (!activeWorkspace) return;
    const candidates = workspaceInviteDraft
      .split(/[,;\n]/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (!candidates.length) {
      showToast('Please enter at least one email address.', 'warning');
      return;
    }

    const invalidEmails = candidates.filter((email) => !EMAIL_REGEX.test(email));
    if (invalidEmails.length) {
      showToast(`The following emails are invalid: ${invalidEmails.join(', ')}`, 'warning');
      return;
    }
    if (activeWorkspaceSettings.block_invites_from_domains && blockedInviteDomains.length) {
      const blockedDomainEmails = candidates.filter(
        (email) => blockedInviteDomains.includes(getEmailDomain(email))
      );
      if (blockedDomainEmails.length) {
        showToast(
          `These email domains cannot join this workspace: ${blockedInviteDomains.join(', ')}`,
          'warning'
        );
        return;
      }
    }

    if (isLoggedIn && username) {
      setWorkspaceActionLoading(true);
      try {
        const res = await authFetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/invitations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            emails: candidates,
            expiry_days: activeWorkspaceSettings.default_invite_expiry_days,
          }),
        }, { authToken });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || 'Failed to create invitations');

        const createdItems = Array.isArray(payload.created) ? payload.created.filter(Boolean) : [];
        const failedItems = Array.isArray(payload.send_errors)
          ? payload.send_errors
              .map((item) => ({
                email: String(item?.email || '').trim(),
                error: String(item?.error || '').trim() || 'Failed to send email',
              }))
              .filter((item) => item.email || item.error)
          : [];
        const invalidResultEmails = Array.isArray(payload.invalid_emails)
          ? payload.invalid_emails.map((item) => String(item || '').trim()).filter(Boolean)
          : [];
        const sentCountRaw = Number(payload.email_sent_count);
        const sentCount = Number.isFinite(sentCountRaw)
          ? Math.max(0, sentCountRaw)
          : Math.max(0, createdItems.length - failedItems.length);

        setLatestInviteDelivery({
          type: 'create',
          createdCount: createdItems.length || candidates.length,
          emailSentCount: sentCount,
          emailFailedCount: failedItems.length,
          failedItems,
          invalidEmails: invalidResultEmails,
          manualShareRecommended: Boolean(payload.manual_share_recommended || failedItems.length),
        });
        setWorkspaceInviteDraft('');
        await refreshWorkspaces({ preferredWorkspaceId: activeWorkspace.id });

        if (failedItems.length) {
          const createdCount = createdItems.length || candidates.length;
          if (sentCount > 0) {
            showToast(
              `Created ${createdCount} invite(s). ${sentCount} email(s) were sent, and ${failedItems.length} could not be delivered.`,
              'warning'
            );
          } else {
            showToast(
              `Created ${createdCount} invite(s), but emails were not sent automatically. Try resending them later.`,
              'warning'
            );
          }
        } else if (createdItems.length || candidates.length) {
          showWorkspaceToast(
            'sharing',
            `Sent ${sentCount || createdItems.length || candidates.length} invitation email(s).`,
            'success'
          );
        }
      } catch (err) {
        showToast(err.message || 'Failed to create invitations', 'error');
      } finally {
        setWorkspaceActionLoading(false);
      }
      return;
    }

    setWorkspaceState((prev) => ({
      ...prev,
      workspaces: prev.workspaces.map((item) => {
        if (item.id !== activeWorkspace.id) return item;
        const nextInvites = Array.from(new Set([...(item.invites || []), ...candidates]));
        return {
          ...item,
          invites: nextInvites,
        };
      }),
    }));
    setWorkspaceInviteDraft('');
    setLatestInviteDelivery({
      type: 'local',
      createdCount: candidates.length,
      emailSentCount: 0,
      emailFailedCount: 0,
      failedItems: [],
      invalidEmails: [],
      manualShareRecommended: true,
    });
    showToast(
      `Saved ${candidates.length} invite target(s) locally. Sign in and configure email delivery to send real invite emails.`,
      'warning'
    );
  };

  const handleRemoveInvite = async (inviteItem) => {
    if (!activeWorkspace) return;
    const target =
      typeof inviteItem === 'string'
        ? inviteItem
        : inviteItem?.email || '';
    const targetInvitationId =
      typeof inviteItem === 'object' && inviteItem
        ? Number(inviteItem.id)
        : NaN;
    const normalizedTarget = String(target || '').trim().toLowerCase();
    const hasServerInvitationId = Number.isFinite(targetInvitationId) && targetInvitationId > 0;

    if (isLoggedIn && username && hasServerInvitationId) {
      setWorkspaceActionLoading(true);
      try {
        const res = await authFetch(
          `/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/invitations/${targetInvitationId}`,
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username }),
          },
          { authToken }
        );
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || 'Failed to remove invitation');
        await refreshWorkspaces({ preferredWorkspaceId: activeWorkspace.id });
      } catch (err) {
        showToast(err.message || 'Failed to remove invitation', 'error');
      } finally {
        setWorkspaceActionLoading(false);
      }
      return;
    }

    const targetEmail = normalizedTarget;
    if (!targetEmail) return;
    setWorkspaceState((prev) => ({
      ...prev,
      workspaces: prev.workspaces.map((item) => {
        if (item.id !== activeWorkspace.id) return item;
        return {
          ...item,
          invites: (item.invites || []).filter((invite) => {
            if (typeof invite === 'string') return invite.toLowerCase() !== targetEmail;
            const inviteEmail = String(invite?.email || '').trim().toLowerCase();
            return inviteEmail !== targetEmail;
          }),
        };
      }),
    }));
  };

  const handleRemoveWorkspaceMember = async (memberItem) => {
    if (!activeWorkspace) return;
    const targetUsername = String(
      typeof memberItem === 'string' ? memberItem : memberItem?.username || ''
    ).trim();
    if (!targetUsername) return;
    if (!isLoggedIn || !username) {
      showToast('Please sign in first.', 'warning');
      return;
    }
    if (activeWorkspace.is_owner === false) {
      showToast('Only the workspace owner can remove members.', 'warning');
      return;
    }
    if (targetUsername === username || targetUsername === activeWorkspace.owner_username) {
      showToast('Workspace owner cannot be removed.', 'warning');
      return;
    }

    const confirmed = await requestConfirmation({
      title: 'Remove Member',
      description: `Remove ${targetUsername} from "${activeWorkspace.name || 'this workspace'}"? They will lose access to this workspace.`,
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!confirmed) return;

    setWorkspaceActionLoading(true);
    try {
      const res = await authFetch(
        `/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/members/${encodeURIComponent(targetUsername)}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username }),
        },
        { authToken }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to remove workspace member');

      if (payload?.workspace?.id) {
        const updatedWorkspace = payload.workspace;
        setWorkspaceState((prev) => ({
          ...prev,
          workspaces: (prev.workspaces || []).map((item) =>
            item.id === updatedWorkspace.id ? updatedWorkspace : item
          ),
        }));
        setWorkspaceNameDraft(updatedWorkspace.name || '');
        setWorkspaceSettingsDraft(normalizeWorkspaceSettings(updatedWorkspace.settings));
      } else {
        await refreshWorkspaces({ preferredWorkspaceId: activeWorkspace.id });
      }
      showWorkspaceToast('sharing', `Removed ${targetUsername} from the workspace.`, 'success');
    } catch (err) {
      showToast(err.message || 'Failed to remove workspace member', 'error');
    } finally {
      setWorkspaceActionLoading(false);
    }
  };

  const handleResendInvitation = async (inviteItem) => {
    if (!activeWorkspace || !isLoggedIn || !username) return;
    const invitationId = Number(inviteItem?.id);
    if (!Number.isFinite(invitationId) || invitationId <= 0) return;

    setWorkspaceActionLoading(true);
    try {
      const res = await authFetch(
        `/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/invitations/${invitationId}/resend`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username }),
        },
        { authToken }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to resend invitation email');

      const targetEmail = String(payload?.email || inviteItem?.email || '').trim();
      const emailSent = Boolean(payload?.email_sent);
      const failedItems = emailSent
        ? []
        : [
            {
              email: targetEmail,
              error: String(payload?.email_error || 'Failed to send email').trim(),
            },
          ];

      setLatestInviteDelivery({
        type: 'resend',
        createdCount: 1,
        emailSentCount: emailSent ? 1 : 0,
        emailFailedCount: emailSent ? 0 : 1,
        failedItems,
        invalidEmails: [],
        manualShareRecommended: !emailSent,
      });
      await refreshWorkspaces({ preferredWorkspaceId: activeWorkspace.id });

      if (emailSent) {
        showWorkspaceToast('sharing', `Resent invitation email to ${targetEmail || 'recipient'}.`, 'success');
      } else {
        showToast('Invitation refreshed, but email was not sent automatically. Try resending it later.', 'warning');
      }
    } catch (err) {
      showToast(err.message || 'Failed to resend invitation email', 'error');
    } finally {
      setWorkspaceActionLoading(false);
    }
  };

  const handleRemoveSavedAccount = (targetUsername) => {
    const target = String(targetUsername || '').trim();
    if (!target) return;
    if (target === storedUsername) {
      handleSignOut({ forgetCurrent: true });
      return;
    }
    const nextHistory = removeAccountFromHistory(target);
    setSavedAccounts(normalizeAccounts(nextHistory));
  };

  const toRecentEntry = (docLike) => {
    const id = toPositiveDocId(docLike?.id ?? docLike);
    if (!id) return null;
    const title = String(docLike?.title || '').trim() || `Note ${id}`;
    return {
      id,
      title: title.slice(0, 200),
      fileType: String(getDocExt(docLike) || docLike?.fileType || '').trim().toLowerCase(),
      updatedAt: new Date().toISOString(),
    };
  };

  const bumpSidebarRecent = (docLike) => {
    const entry = toRecentEntry(docLike);
    if (!entry) return;
    const id = entry.id;
    setSidebarRecentMeta((prev) => ({
      ...(prev || {}),
      [id]: {
        ...(prev?.[id] || {}),
        ...entry,
      },
    }));
    setSidebarRecentIds((prev) => [id, ...prev.filter((item) => item !== id)].slice(0, activeRecentLimit));
  };

  const toStarredEntry = (doc) => {
    const id = toPositiveDocId(doc?.id);
    if (!id) return null;
    const title = String(doc?.title || '').trim() || `Note ${id}`;
    return {
      id,
      title: title.slice(0, 200),
      fileType: String(getDocExt(doc) || doc?.fileType || '').trim().toLowerCase(),
      updatedAt: new Date().toISOString(),
    };
  };

  const toSummaryHistoryEntry = (docLike, result, options = {}) => {
    const optionsUsed = result?.options_used && typeof result.options_used === 'object'
      ? result.options_used
      : {};
    const normalized = normalizeSummaryHistoryEntry({
      id: options.id || createClientId('summary'),
      docId: toPositiveDocId(options.docId ?? docLike?.id ?? result?.document_id),
      title: String(options.title || docLike?.title || '').trim(),
      fileType: String(options.fileType || getDocExt(docLike) || docLike?.fileType || '').trim().toLowerCase(),
      summary: String(result?.summary || '').trim(),
      keywords: Array.isArray(result?.keywords) ? result.keywords : [],
      keySentences: Array.isArray(result?.key_sentences) ? result.key_sentences : [],
      summarySource: normalizeSummarySource(result?.summary_source || ''),
      summaryNote: String(result?.summary_note || '').trim(),
      summaryLength: String(result?.options_used?.summary_length || activeWorkspaceSettings.summary_length || 'medium')
        .trim()
        .toLowerCase(),
      chunkCount: Math.max(1, Number(optionsUsed.chunk_count) || 1),
      mergeRounds: Math.max(0, Number(optionsUsed.merge_rounds) || 0),
      refreshedFromFile: Boolean(optionsUsed.refreshed_from_file),
      pdfExtractor: String(optionsUsed.pdf_extractor || '').trim(),
      pdfOcrUsed: Boolean(optionsUsed.pdf_ocr_used),
      textWordCount: Math.max(0, Number(optionsUsed.text_word_count) || 0),
      textCharCount: Math.max(0, Number(optionsUsed.text_char_count) || 0),
      summarizerModel: String(optionsUsed.summarizer_model || '').trim(),
      optionsUsed,
      generatedAt: new Date().toISOString(),
    });
    return normalized;
  };

  const toSummaryExportPayload = (entry) => {
    const normalized = normalizeSummaryHistoryEntry(entry);
    if (!normalized) return null;
    return {
      summary: normalized.summary,
      keywords: normalized.keywords,
      key_sentences: normalized.keySentences,
      summary_source: normalized.summarySource,
      summary_note: normalized.summaryNote,
    };
  };

  const pushSummaryHistoryEntry = (entry) => {
    const normalized = normalizeSummaryHistoryEntry(entry);
    if (!normalized) return;
    setSummaryHistory((prev) => {
      const next = [
        normalized,
        ...prev.filter((item) => String(item.id) !== normalized.id),
      ];
      return next.slice(0, MAX_SUMMARY_HISTORY_PER_WORKSPACE);
    });
  };

  const removeSummaryHistoryEntry = (entryId) => {
    const safeId = String(entryId || '').trim();
    if (!safeId) return;
    setSummaryHistory((prev) => prev.filter((item) => String(item.id) !== safeId));
  };

  const handleToggleStarredNote = (doc, options = {}) => {
    const entry = toStarredEntry(doc);
    if (!entry) return false;
    const silent = Boolean(options.silent);
    let nextActive = false;
    setStarredNotes((prev) => {
      const exists = prev.some((item) => toPositiveDocId(item.id) === entry.id);
      if (exists) {
        nextActive = false;
        return prev.filter((item) => toPositiveDocId(item.id) !== entry.id);
      }
      nextActive = true;
      const next = [entry, ...prev.filter((item) => toPositiveDocId(item.id) !== entry.id)];
      return next.slice(0, MAX_STARRED_NOTES_PER_WORKSPACE);
    });
    if (!silent) {
      showToast(nextActive ? `Starred "${entry.title}".` : `Removed "${entry.title}" from Starred.`, 'success');
    }
    return nextActive;
  };

  const handleOpenStarredNote = (entry) => {
    const id = toPositiveDocId(entry?.id);
    if (!id) return;
    void openDocumentInPane(id, { fromSidebar: true, seedDoc: entry });
  };

  const handleStarredDragStart = (entryId) => {
    const id = toPositiveDocId(entryId);
    if (!id) return;
    setStarredDragId(id);
  };

  const handleStarredDrop = (targetId) => {
    const target = toPositiveDocId(targetId);
    const dragged = toPositiveDocId(starredDragId);
    setStarredDragId(0);
    if (!target || !dragged || target === dragged) return;
    setStarredNotes((prev) => {
      const fromIndex = prev.findIndex((item) => toPositiveDocId(item.id) === dragged);
      const toIndex = prev.findIndex((item) => toPositiveDocId(item.id) === target);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const handleStarredDragEnd = () => {
    setStarredDragId(0);
  };

  const openSummaryResultModal = (result, title = '', historyEntry = null, options = {}) => {
    setAnalysisResult(result);
    setSummaryResultTitle(String(title || '').trim());
    setSummaryResultHistoryEntry(normalizeSummaryHistoryEntry(historyEntry));
    setSummaryResultReturnToCenter(Boolean(options?.returnToSummaryCenter));
    setSummaryResultOpen(true);
  };

  const closeSummaryResultModal = () => {
    const shouldReturnToCenter = summaryResultReturnToCenter;
    setSummaryResultOpen(false);
    setSummaryResultReturnToCenter(false);
    if (shouldReturnToCenter) {
      setSummaryCenterOpen(true);
    }
  };

  const closeOcrResultModal = () => {
    setOcrResultOpen(false);
    setOcrSourceContext(null);
    setOcrSaveFormat('txt');
    setExtractedText('');
    if (!summaryResultOpen) {
      setAnalysisResult(null);
      setSummaryResultTitle('');
      setSummaryResultHistoryEntry(null);
      setSummaryResultReturnToCenter(false);
    }
  };

  const handleExtractText = async (imageFile, options = {}) => {
    if (!imageFile) {
      showToast('Please select an image first.', 'warning');
      return;
    }
    if (!isLoggedIn || !authToken || !username) {
      showToast('Please sign in to use OCR.', 'warning');
      return;
    }
    if (!activeWorkspaceSettings.allow_ai_tools) {
      showToast('AI tools are disabled in this workspace settings.', 'warning');
      return;
    }
    if (!activeWorkspaceSettings.allow_ocr) {
      showToast('OCR is disabled in this workspace settings.', 'warning');
      return;
    }

    setIsExtracting(true);
    const formData = new FormData();
    formData.append('image', imageFile);
    if (username) formData.append('username', username);
    if (activeWorkspaceId) formData.append('workspace_id', activeWorkspaceId);

    try {
      const response = await authFetch('/api/extract-text', {
        method: 'POST',
        body: formData,
      }, { authToken });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        showToast(`Text extraction failed: ${formatOcrErrorMessage(data)}`, 'error');
        return;
      }

      const nextText = coerceOcrText(data?.text ?? data);
      const sourceDoc = options?.sourceDoc || null;
      const sourceTitle = String(
        sourceDoc?.title || imageFile?.name || options?.sourceTitle || 'Selected image'
      ).trim();
      const sourceCategory = String(
        sourceDoc?.category || options?.category || uploadCategory || activeWorkspaceSettings.default_category || ''
      ).trim();
      setSummaryResultOpen(false);
      setSummaryResultTitle('');
      setExtractedText(nextText);
      setAnalysisResult(null);
      setOcrSourceContext({
        title: sourceTitle,
        detail: String(data?.source || '').trim(),
        category: sourceCategory,
        workspaceId: String(sourceDoc?.workspace_id || sourceDoc?.workspaceId || activeWorkspaceId || '').trim(),
        sourceDocId: toPositiveDocId(sourceDoc?.id),
      });
      setOcrResultOpen(true);
      if (!nextText) {
        const source = String(data?.source || '').trim();
        showToast(
          `OCR finished${source ? ` (${source})` : ''}, but no readable text was returned.`,
          'warning'
        );
      }
    } catch (error) {
      console.error('Extract text failed:', error);
      showToast('Text extraction request failed. Please try again later.', 'error');
    } finally {
      setIsExtracting(false);
    }
  };

  const handleOcrImageChange = async (event) => {
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    const sourceDoc = pendingOcrSourceRef.current || null;
    pendingOcrSourceRef.current = null;
    if (!file) return;
    if (!activeWorkspaceSettings.allow_ai_tools || !activeWorkspaceSettings.allow_ocr) return;
    await handleExtractText(file, { sourceDoc });
  };

  const openImageOcrPicker = (sourceDoc = null) => {
    if (!activeWorkspaceSettings.allow_ai_tools || !activeWorkspaceSettings.allow_ocr) return;
    if (isExtracting) return;
    if (!isLoggedIn || !authToken || !username) {
      showToast('Please sign in to use OCR.', 'warning');
      return;
    }
    pendingOcrSourceRef.current = sourceDoc || null;
    ocrImageInputRef.current?.click();
  };

  const loadImageDocumentAsFile = async (doc) => {
    const docId = toPositiveDocId(doc?.id);
    if (!docId) throw new Error('Invalid image document');
    const response = await authFetch(`/api/documents/${docId}/file`, {}, { authToken });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Failed to load image file');
    }
    const blob = await response.blob();
    const filename = String(doc?.filename || doc?.title || `document-${docId}.png`).trim();
    const safeType = blob.type || `image/${getDocExt(doc) || 'png'}`;
    return new File([blob], filename, { type: safeType });
  };

  const handleRunDocumentImageOcr = async (doc) => {
    const fileType = String(getDocExt(doc) || '').trim().toLowerCase();
    if (!IMAGE_FILE_TYPE_VALUES.has(fileType)) {
      showToast('Scan Image is only available for image notes.', 'warning');
      return;
    }
    try {
      const file = await loadImageDocumentAsFile(doc);
      await handleExtractText(file, { sourceDoc: doc });
    } catch (error) {
      showToast(error?.message || 'Failed to load image file for OCR.', 'error');
    }
  };

  const startSummaryProgress = ({ forceRefresh = false, docId = 0, docTitle = '' } = {}) => {
    if (summaryProgressTimerRef.current) {
      window.clearTimeout(summaryProgressTimerRef.current);
      summaryProgressTimerRef.current = null;
    }
    const token = createClientId('summary-progress');
    const nextDocId = toPositiveDocId(docId);
    const shouldRefreshText = Boolean(forceRefresh && nextDocId > 0);
    setSummaryProgress({
      active: true,
      token,
      phase: shouldRefreshText ? 'refreshing' : 'summarizing',
      forceRefresh: shouldRefreshText,
      docId: nextDocId,
      docTitle: String(docTitle || '').trim(),
    });
    if (shouldRefreshText) {
      summaryProgressTimerRef.current = window.setTimeout(() => {
        setSummaryProgress((prev) => {
          if (!prev.active || prev.token !== token) return prev;
          return {
            ...prev,
            phase: 'summarizing',
          };
        });
      }, 1800);
    }
    return token;
  };

  const stopSummaryProgress = (token = '') => {
    if (summaryProgressTimerRef.current) {
      window.clearTimeout(summaryProgressTimerRef.current);
      summaryProgressTimerRef.current = null;
    }
    setSummaryProgress((prev) => {
      if (!prev.active) return prev;
      if (token && prev.token && prev.token !== token) return prev;
      return DEFAULT_SUMMARY_PROGRESS;
    });
  };

  const summaryProgressLabel = useMemo(() => {
    if (!summaryProgress.active) return '';
    if (summaryProgress.forceRefresh && summaryProgress.phase === 'refreshing') {
      return 'Refreshing PDF text from source file...';
    }
    if (summaryProgress.forceRefresh) {
      return 'Running full-document chunk summary...';
    }
    return 'Generating summary...';
  }, [summaryProgress]);

  const requestSummary = async ({
    text = '',
    docId = 0,
    docTitle = '',
    trackLoading = true,
    silentError = false,
    forceRefresh = false,
  } = {}) => {
    if (!isLoggedIn || !authToken || !username) {
      if (!silentError) {
        showToast('Please sign in to use AI tools.', 'warning');
      }
      return null;
    }
    const payload = {
      username: username || '',
      workspace_id: activeWorkspaceId || '',
      summary_length: activeWorkspaceSettings.summary_length,
      keyword_limit: activeWorkspaceSettings.keyword_limit,
    };
    const safeText = String(text || '').trim();
    const safeDocId = Number(docId) || 0;
    if (safeText) payload.text = safeText;
    if (safeDocId > 0) payload.doc_id = safeDocId;
    if (forceRefresh) payload.force_refresh = true;
    const progressToken = trackLoading
      ? startSummaryProgress({
          forceRefresh,
          docId: safeDocId,
          docTitle: String(docTitle || '').trim(),
        })
      : '';

    if (trackLoading) setIsAnalyzing(true);
    try {
      const response = await authFetch('/api/analyze-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, { authToken });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(formatSummaryErrorMessage(data));
      }
      return data;
    } catch (error) {
      console.error('Analyze text failed:', error);
      if (!silentError) {
        showToast(`Analysis failed: ${error.message || 'Service error'}`, 'error');
      }
      return null;
    } finally {
      if (trackLoading) {
        setIsAnalyzing(false);
        stopSummaryProgress(progressToken);
      }
    }
  };

  const handleAnalyzeText = async (options = {}) => {
    const forceRefresh = Boolean(options?.forceRefresh);
    if (!activeWorkspaceSettings.allow_ai_tools) {
      showToast('AI tools are disabled in this workspace settings.', 'warning');
      return;
    }
    if (!extractedText.trim()) {
      showToast('The text box is empty. Cannot analyze.', 'warning');
      return;
    }

    const data = await requestSummary({
      text: extractedText,
      forceRefresh,
      docTitle: String(ocrSourceContext?.title || 'Scan Image').trim(),
    });
    if (!data) return;
    const docId = toPositiveDocId(data?.document_id);
    const sourceDoc = docId ? documents.find((item) => toPositiveDocId(item.id) === docId) : null;
    const historyEntry = toSummaryHistoryEntry(sourceDoc || activeDoc || { id: docId }, data, {
      docId,
      title: sourceDoc?.title || ocrSourceContext?.title || activeDoc?.title || (docId ? `Note ${docId}` : 'OCR Text'),
      fileType: sourceDoc ? getDocExt(sourceDoc) : 'txt',
    });
    if (historyEntry) {
      pushSummaryHistoryEntry(historyEntry);
    }
    openSummaryResultModal(data, historyEntry?.title || ocrSourceContext?.title || 'OCR Text', historyEntry);
    if (data.cache_hit) {
      showWorkspaceToast('summary', 'Loaded summary from cache.', 'success');
    } else if (forceRefresh) {
      showWorkspaceToast('summary', 'Summary regenerated.', 'success');
    } else {
      showWorkspaceToast('summary', 'Summary is ready.', 'success');
    }
  };

  const handleCopySummary = async () => {
    if (!activeWorkspaceSettings.allow_export) {
      showToast('Export is disabled in this workspace settings.', 'warning');
      return;
    }
    const output = buildSummaryExportText(analysisResult);
    if (!output) return;
    try {
      await copyTextToClipboard(output);
      showWorkspaceToast('summary', 'Summary copied to clipboard.', 'success');
    } catch {
      showToast('Copy failed. Please copy manually.', 'error');
    }
  };

  const handleExportSummary = () => {
    if (!activeWorkspaceSettings.allow_export) {
      showToast('Export is disabled in this workspace settings.', 'warning');
      return;
    }
    const output = buildSummaryExportText(analysisResult);
    if (!output) return;
    downloadTextFile(buildSummaryExportFilename('txt'), output);
  };

  const handleExportSummaryPdf = async () => {
    if (!activeWorkspaceSettings.allow_export) {
      showToast('Export is disabled in this workspace settings.', 'warning');
      return;
    }
    const output = buildSummaryExportText(analysisResult);
    if (!output) return;
    try {
      await downloadSummaryPdf(buildSummaryExportFilename('pdf'), analysisResult);
    } catch (error) {
      console.error('Failed to export summary PDF', error);
      showToast('PDF export failed. Please try TXT export instead.', 'error');
    }
  };

  const handleEmailSummary = () => {
    if (!activeWorkspaceSettings.allow_export) {
      showToast('Export is disabled in this workspace settings.', 'warning');
      return;
    }
    openSummaryEmailDraft(analysisResult);
  };

  const handleSaveOcrResult = async () => {
    if (!username) {
      showToast('Please sign in to save OCR text as a note.', 'warning');
      return;
    }
    const safeText = String(extractedText || '').trim();
    if (!safeText) {
      showToast('There is no OCR text to save yet.', 'warning');
      return;
    }

    setIsSavingOcrResult(true);
    try {
      const sourceDocId = toPositiveDocId(ocrSourceContext?.sourceDocId);
      const payload = {
        username,
        text: safeText,
        title: buildOcrNoteTitle(ocrSourceContext?.title),
        file_format: ocrSaveFormat,
      };
      if (sourceDocId > 0) {
        const response = await authFetch(`/api/documents/${sourceDocId}/import-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }, { authToken });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || 'Failed to save OCR note');
        }
      } else {
        const response = await authFetch('/api/documents/import-text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            workspace_id: ocrSourceContext?.workspaceId || activeWorkspaceId,
            category: ocrSourceContext?.category || activeWorkspaceSettings.default_category || DEFAULT_NOTE_CATEGORY,
          }),
        }, { authToken });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || 'Failed to save OCR note');
        }
      }
      setDocumentsPage(1);
      await fetchDocuments(1);
      showWorkspaceToast(
        'upload',
        `OCR text saved as a new ${String(ocrSaveFormat || 'txt').toUpperCase()} note.`,
        'success'
      );
    } catch (error) {
      showToast(error?.message || 'Failed to save OCR note.', 'error');
    } finally {
      setIsSavingOcrResult(false);
    }
  };

  const handleOpenSummaryCenter = () => {
    setSummaryCenterActionId('');
    setSummaryCenterOpen(true);
  };

  const handleApplySummaryHistoryItem = (item) => {
    const entry = normalizeSummaryHistoryEntry(item);
    if (!entry) return;
    openSummaryResultModal({
      ...toSummaryExportPayload(entry),
      options_used: {
        summary_length: entry.summaryLength,
        chunk_count: entry.chunkCount,
        merge_rounds: entry.mergeRounds,
        refreshed_from_file: entry.refreshedFromFile,
        pdf_extractor: entry.pdfExtractor,
        pdf_ocr_used: entry.pdfOcrUsed,
        text_word_count: entry.textWordCount,
        text_char_count: entry.textCharCount,
        summarizer_model: entry.summarizerModel,
      },
      document_id: entry.docId || null,
      text_source: 'summary_history',
    }, entry.title, entry, { returnToSummaryCenter: true });
    setSummaryCenterOpen(false);
    showWorkspaceToast('summary', `Loaded summary for "${entry.title}".`, 'success');
  };

  const handleClearSummaryHistory = async () => {
    if (!summaryHistory.length) return;
    const shouldClear = await requestConfirmation({
      title: 'Clear summary history?',
      description: 'Saved summary outputs in this workspace will be removed.',
      confirmLabel: 'Clear',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!shouldClear) return;
    setSummaryHistory([]);
    showWorkspaceToast('summary', 'Summary history cleared.', 'success');
  };

  const getSummarySourceLabel = (value) => {
    const normalized = normalizeSummarySource(value);
    if (normalized === 'cache') return 'Cache';
    if (normalized === 'huggingface') return 'HuggingFace';
    if (normalized === 'fallback') return 'Fallback';
    return normalized || 'Unknown';
  };

  const toggleSummaryHistoryExpanded = (entryId) => {
    const safeId = String(entryId || '').trim();
    if (!safeId) return;
    setSummaryCenterExpandedIds((prev) =>
      prev.includes(safeId)
        ? prev.filter((item) => item !== safeId)
        : [...prev, safeId]
    );
  };

  const handleRebuildSummaryHistoryItem = async (entry) => {
    const targetDocId = toPositiveDocId(entry?.docId);
    if (!targetDocId) {
      showToast('This summary has no linked document ID.', 'warning');
      return;
    }
    const safeEntryId = String(entry?.id || '').trim();
    setSummaryCenterActionId(safeEntryId || `doc-${targetDocId}`);
    const progressToken = startSummaryProgress({
      forceRefresh: true,
      docId: targetDocId,
      docTitle: String(entry?.title || '').trim(),
    });
    try {
      const result = await requestSummary({
        docId: targetDocId,
        text: '',
        docTitle: String(entry?.title || '').trim(),
        trackLoading: false,
        forceRefresh: true,
      });
      if (!result) return;
      const docLike =
        documents.find((item) => toPositiveDocId(item.id) === targetDocId) ||
        activeDoc ||
        { id: targetDocId, title: entry?.title || `Note ${targetDocId}` };
      const nextEntry = toSummaryHistoryEntry(docLike, result, {
        id: safeEntryId || undefined,
        docId: targetDocId,
        title: entry?.title || docLike?.title,
        fileType: entry?.fileType || getDocExt(docLike),
      });
      if (nextEntry) {
        pushSummaryHistoryEntry(nextEntry);
      }
      if (summaryResultOpen) {
        openSummaryResultModal(result, nextEntry?.title || entry?.title || docLike?.title || '', nextEntry || {
          ...entry,
          docId: targetDocId,
        }, {
          returnToSummaryCenter: summaryResultReturnToCenter,
        });
      }
      showWorkspaceToast('summary', 'Summary rebuilt successfully.', 'success');
    } finally {
      stopSummaryProgress(progressToken);
      setSummaryCenterActionId('');
    }
  };

  const handleRebuildCurrentSummaryResult = () => {
    if (!summaryResultHistoryEntry) return;
    return handleRebuildSummaryHistoryItem(summaryResultHistoryEntry);
  };

  const handleUseDocumentForAI = async (doc, options = {}) => {
    const forceRefresh = Boolean(options?.forceRefresh);
    if (!activeWorkspaceSettings.allow_ai_tools) {
      showToast('AI tools are disabled in this workspace settings.', 'warning');
      return;
    }
    const processingMeta = getDocumentProcessingMeta(doc);
    if (processingMeta) {
      showToast(processingMeta.summarizeTitle, 'warning');
      return;
    }
    const text = String(doc?.content || '').trim();
    const docId = Number(doc?.id) || 0;
    if (!text && docId <= 0) {
      showToast('This note has no extracted text yet.', 'warning');
      return;
    }
    setAnalysisResult(null);
    setSummaryResultOpen(false);
    const result = await requestSummary({
      text: docId > 0 ? '' : text,
      docId,
      docTitle: String(doc?.title || '').trim(),
      forceRefresh,
    });
    if (!result) return;
    const historyEntry = toSummaryHistoryEntry(doc, result, { docId });
    if (historyEntry) {
      pushSummaryHistoryEntry(historyEntry);
    }
    openSummaryResultModal(result, String(doc?.title || '').trim(), historyEntry);
    if (result.cache_hit) {
      showWorkspaceToast('summary', 'Loaded document summary from cache.', 'success');
    } else if (forceRefresh) {
      showWorkspaceToast('summary', 'Document summary regenerated.', 'success');
    } else {
      showWorkspaceToast('summary', 'Document summary is ready.', 'success');
    }
  };

  const handleRegenerateDocumentSummary = (doc) => {
    if (!doc) return;
    return handleUseDocumentForAI(doc, { forceRefresh: true });
  };

  const refreshActiveDocShareLinks = async (docId = activeDoc?.id) => {
    const targetDocId = Number(docId);
    const targetWorkspaceId = String(
      (workspaceReady ? activeWorkspaceId : '') ||
        activeDoc?.workspace_id ||
        activeDoc?.workspaceId ||
        ''
    ).trim();
    if (!workspaceReady || !username || !canCurrentUserManageShareLinks || (!targetWorkspaceId && (!Number.isFinite(targetDocId) || targetDocId <= 0))) {
      clearActiveDocShareState();
      return;
    }
    setActiveDocShareLinksLoading(true);
    setActiveDocShareLinksError('');
    try {
      const items = targetWorkspaceId
        ? await listWorkspaceShareLinks(targetWorkspaceId, { username, limit: 100 })
        : await listDocumentShareLinks(targetDocId, { username });
      setActiveDocShareLinks(items);
    } catch (err) {
      setActiveDocShareLinks([]);
      setActiveDocShareLinksError(err.message || 'Failed to load share links');
    } finally {
      setActiveDocShareLinksLoading(false);
    }
  };

  const handleRevokeActiveDocShareLink = async (shareLink) => {
    if (!username || !canCurrentUserManageShareLinks) return;
    const shareLinkId = Number(shareLink?.id);
    const shareDocId = Number(shareLink?.document_id || shareLink?.documentId || activeDoc?.id);
    if (!Number.isFinite(shareLinkId) || shareLinkId <= 0) return;
    if (!Number.isFinite(shareDocId) || shareDocId <= 0) return;
    setActiveDocShareActionLoadingId(shareLinkId);
    setActiveDocShareActionLoadingType('revoke');
    try {
      await revokeDocumentShareLink(shareDocId, shareLinkId, { username });
      await refreshActiveDocShareLinks(activeDoc?.id);
    } catch (err) {
      showToast(err.message || 'Failed to revoke share link', 'error');
    } finally {
      setActiveDocShareActionLoadingId(0);
      setActiveDocShareActionLoadingType('');
    }
  };

  const handleDeleteActiveDocShareLink = async (shareLink) => {
    if (!username || !canCurrentUserManageShareLinks) return;
    const shareLinkId = Number(shareLink?.id);
    const shareDocId = Number(shareLink?.document_id || shareLink?.documentId || activeDoc?.id);
    if (!Number.isFinite(shareLinkId) || shareLinkId <= 0) return;
    if (!Number.isFinite(shareDocId) || shareDocId <= 0) return;
    const shouldDelete = await requestConfirmation({
      title: 'Delete share link record?',
      description: 'This removes the inactive share link from the list permanently.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!shouldDelete) return;

    setActiveDocShareActionLoadingId(shareLinkId);
    setActiveDocShareActionLoadingType('delete');
    try {
      await deleteDocumentShareLink(shareDocId, shareLinkId, { username });
      await refreshActiveDocShareLinks(activeDoc?.id);
      showWorkspaceToast('sharing', 'Share link deleted.', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to delete share link', 'error');
    } finally {
      setActiveDocShareActionLoadingId(0);
      setActiveDocShareActionLoadingType('');
    }
  };

  const handleDeleteInactiveActiveDocShareLinks = async () => {
    const targetWorkspaceId = String(activeWorkspaceId || '').trim();
    if (!username || !canCurrentUserManageShareLinks || (!targetWorkspaceId && !activeDoc)) return;
    const shouldDelete = await requestConfirmation({
      title: 'Delete all inactive share links?',
      description: targetWorkspaceId
        ? 'This permanently removes all expired and revoked share links in this workspace.'
        : 'This permanently removes all expired and revoked share links from the list.',
      confirmLabel: 'Delete All Inactive',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!shouldDelete) return;

    setActiveDocShareActionLoadingId(-2);
    setActiveDocShareActionLoadingType('delete-inactive');
    try {
      const payload = targetWorkspaceId
        ? await deleteInactiveWorkspaceShareLinks(targetWorkspaceId, { username })
        : await deleteInactiveDocumentShareLinks(activeDoc.id, { username });
      setActiveDocShareLinks(Array.isArray(payload.items) ? payload.items : []);
      showWorkspaceToast('sharing', `Deleted ${payload.deleted_count || 0} inactive share link(s).`, 'success');
    } catch (err) {
      showToast(err.message || 'Failed to delete inactive share links', 'error');
    } finally {
      setActiveDocShareActionLoadingId(0);
      setActiveDocShareActionLoadingType('');
    }
  };

  const handleRevokeAllActiveDocShareLinks = async () => {
    const targetWorkspaceId = String(activeWorkspaceId || '').trim();
    if (!username || !canCurrentUserManageShareLinks || (!targetWorkspaceId && !activeDoc)) return;
    const shouldRevokeAll = await requestConfirmation({
      title: 'Revoke all share links?',
      description: targetWorkspaceId
        ? 'All active links in this workspace will be revoked immediately.'
        : 'All active links of this document will be revoked immediately.',
      confirmLabel: 'Revoke All',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!shouldRevokeAll) return;
    setActiveDocShareActionLoadingId(-1);
    setActiveDocShareActionLoadingType('revoke-all');
    try {
      const payload = targetWorkspaceId
        ? await revokeAllWorkspaceShareLinks(targetWorkspaceId, { username })
        : await revokeAllDocumentShareLinks(activeDoc.id, { username });
      setActiveDocShareLinks(Array.isArray(payload.items) ? payload.items : []);
      showWorkspaceToast('sharing', `Revoked ${payload.revoked_count || 0} share link(s).`, 'success');
    } catch (err) {
      showToast(err.message || 'Failed to revoke all share links', 'error');
    } finally {
      setActiveDocShareActionLoadingId(0);
      setActiveDocShareActionLoadingType('');
    }
  };

  const handleCopyExistingShareLink = async (shareUrl) => {
    const value = String(shareUrl || '').trim();
    if (!value) {
      showToast('No share link is available to copy.', 'warning');
      return;
    }
    try {
      await copyTextToClipboard(value);
      showWorkspaceToast('sharing', 'Share link copied.', 'success');
    } catch {
      showToast('Copy failed. Please copy manually.', 'error');
    }
  };

  const getShareDisabledReasonForDoc = (doc = activeDoc) => {
    if (activeWorkspaceSettings.link_sharing_mode === 'restricted') {
      return 'Link sharing is restricted by workspace settings.';
    }
    if (!username) {
      return 'Please sign in to share this note.';
    }
    if (!canCurrentUserManageShareLinks) {
      return 'Only workspace owner can create share links in current settings.';
    }
    const docId = Number(doc?.id);
    if (!Number.isFinite(docId) || docId <= 0) {
      return 'Open a note before sharing.';
    }
    return '';
  };

  const closeActiveDocShareEmailModal = () => {
    if (activeDocShareEmailSending) return;
    setActiveDocShareEmailOpen(false);
    setActiveDocShareModalMode('send');
    resetActiveDocShareEmailDraft();
  };

  const openActiveDocShareSendModal = () => {
    const disabledReason = getShareDisabledReasonForDoc(activeDoc);
    if (disabledReason) {
      showToast(disabledReason, 'warning');
      return;
    }
    resetActiveDocShareEmailDraft();
    setActiveDocShareModalMode('send');
    setActiveDocShareEmailOpen(true);
  };

  const openActiveDocShareManagerInModal = () => {
    const disabledReason = workspaceShareManagementDisabledReason;
    if (disabledReason) {
      showToast(disabledReason, 'warning');
      return;
    }
    resetActiveDocShareEmailDraft();
    setActiveDocShareModalMode('manage');
    setActiveDocShareEmailOpen(true);
    void refreshActiveDocShareLinks();
  };

  const handleActiveDocShareSendAnother = () => {
    resetActiveDocShareEmailDraft();
    setActiveDocShareModalMode('send');
  };

  const handleSendActiveDocByEmail = async (event) => {
    event?.preventDefault?.();
    const disabledReason = getShareDisabledReasonForDoc(activeDoc);
    if (disabledReason) {
      showToast(disabledReason, 'warning');
      return;
    }

    const recipientEmail = String(activeDocShareEmailRecipient || '').trim();
    if (!recipientEmail) {
      showToast('Please enter a recipient email address.', 'warning');
      return;
    }
    if (!EMAIL_REGEX.test(recipientEmail)) {
      showToast('Please enter a valid recipient email address.', 'warning');
      return;
    }

    setActiveDocShareEmailSending(true);
    try {
      const payload = await sendDocumentShareLinkEmail(activeDoc.id, {
        username,
        recipientEmail,
        message: activeDocShareEmailMessage,
        expiryDays: activeDocShareEmailExpiryDays,
      });
      await refreshActiveDocShareLinks(activeDoc.id);
      setActiveDocShareEmailResult(payload);
      setActiveDocShareModalMode('success');
      showWorkspaceToast(
        'sharing',
        payload.message || `Shared note email sent to ${recipientEmail}.`,
        'success'
      );
    } catch (err) {
      showToast(err.message || 'Failed to send note by email.', 'error');
    } finally {
      setActiveDocShareEmailSending(false);
    }
  };

  const handleCopySentActiveDocShareLink = async () => {
    const shareUrl = String(activeDocShareEmailResult?.share?.share_url || '').trim();
    if (!shareUrl) {
      showToast('No share link was returned for this email.', 'warning');
      return;
    }
    await handleCopyExistingShareLink(shareUrl);
  };

  const handleShareDocument = async (doc) => {
    const disabledReason = getShareDisabledReasonForDoc(doc);
    if (disabledReason) {
      showToast(disabledReason, 'warning');
      return;
    }
    const docId = Number(doc?.id);
    if (!Number.isFinite(docId)) return;
    try {
      const { payload, shareUrl } = await createDocumentShareLink(docId, {
        username,
        expiryDays: activeWorkspaceSettings.default_share_expiry_days,
      });
      await copyTextToClipboard(shareUrl);
      showWorkspaceToast(
        'sharing',
        `Share link copied. Expires in ${payload.expiry_days || activeWorkspaceSettings.default_share_expiry_days} day(s).`,
        'success'
      );
      if (activeDoc?.id === docId) {
        await refreshActiveDocShareLinks(docId);
      }
    } catch (err) {
      showToast(err.message || 'Failed to create share link.', 'error');
    }
  };

  const handleClearWorkspaceDocuments = async () => {
    if (!activeWorkspaceId || !username || !isLoggedIn) {
      showToast('Please sign in first.', 'warning');
      return;
    }
    const confirmation = await requestTextInput({
      title: 'Delete All Workspace Notes',
      description: `Type CLEAR to delete all notes in workspace "${activeWorkspace?.name || ''}".`,
      placeholder: 'CLEAR',
      initialValue: '',
      confirmLabel: 'Delete All',
      cancelLabel: 'Cancel',
      danger: true,
      required: true,
      trimResult: true,
    });
    if (confirmation === null) return;
    if (confirmation !== 'CLEAR') {
      showToast('Confirmation text mismatch. No notes were deleted.', 'warning');
      return;
    }

    setWorkspaceActionLoading(true);
    try {
      const res = await authFetch(`/api/workspaces/${encodeURIComponent(activeWorkspaceId)}/documents`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      }, { authToken });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to clear workspace notes');

      resetDocumentsData();
      setSidebarRecentIds([]);
      setSidebarRecentMeta({});
      setStarredNotes([]);
      setSummaryHistory([]);
      setSummaryCenterOpen(false);
      setSummaryCenterQuery('');
      setSidebarMenuDocId(null);
      setTrashModalOpen(false);
      setTrashItems([]);
      setTrashTotal(0);
      setTrashPurgedCount(0);
      setTrashLoadError('');
      setTrashLoading(false);
      setTrashActionLoadingId('');
      setSelectedTrashDocumentIds([]);
      setTrashBulkActionLoading(false);
      setTrashPage(1);
      setTrashPageSize(TRASH_PAGE_SIZE_OPTIONS[1]);
      setTrashSort('deleted_newest');
      setTrashQuery('');
      setActiveDoc(null);
      setActiveDocError('');
      setActiveDocLoading(false);
      setActiveDocFileVersion(0);
      setActiveDocEditMode(false);
      setActiveDocDraftHtml('');
      setActiveDocSaveError('');
      clearActiveDocShareState();

      const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
      if (warnings.length) {
        showToast(
          `Deleted ${payload.deleted_count || 0} notes. Some files could not be removed from storage.`,
          'warning'
        );
      } else {
        showToast(`Deleted ${payload.deleted_count || 0} notes from this workspace.`, 'success');
      }
      setWorkspaceSettingsOpen(false);
    } catch (err) {
      showToast(err.message || 'Failed to clear workspace notes', 'error');
    } finally {
      setWorkspaceActionLoading(false);
    }
  };

  const handleDeleteWorkspace = async (workspaceToDelete = activeWorkspace) => {
    const targetWorkspace = workspaceToDelete || activeWorkspace;
    const targetWorkspaceId = String(targetWorkspace?.id || '').trim();
    if (!targetWorkspaceId || !username || !isLoggedIn) {
      showToast('Please sign in first.', 'warning');
      return;
    }
    if (targetWorkspace?.is_owner === false) {
      showToast('Only the workspace owner can delete this workspace.', 'warning');
      return;
    }

    const workspaceLabel = String(targetWorkspace?.name || '').trim();
    const confirmation = await requestTextInput({
      title: 'Delete Workspace',
      description: `Type ${workspaceLabel || 'the workspace name'} to permanently delete this workspace and all notes inside it.`,
      placeholder: workspaceLabel || 'Workspace name',
      initialValue: '',
      confirmLabel: 'Delete Workspace',
      cancelLabel: 'Cancel',
      danger: true,
      required: true,
      trimResult: true,
    });
    if (confirmation === null) return;
    if (!workspaceLabel || confirmation !== workspaceLabel) {
      showToast('Confirmation text mismatch. Workspace was not deleted.', 'warning');
      return;
    }

    setWorkspaceActionLoading(true);
    try {
      const removingActiveWorkspace = targetWorkspaceId === activeWorkspaceId;
      const res = await authFetch(`/api/workspaces/${encodeURIComponent(targetWorkspaceId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      }, { authToken });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to delete workspace');

      if (removingActiveWorkspace) {
        resetDocumentsData();
        setSidebarRecentIds([]);
        setSidebarRecentMeta({});
        setStarredNotes([]);
        setSummaryHistory([]);
        setSummaryCenterOpen(false);
        setSummaryCenterQuery('');
        setSidebarMenuDocId(null);
        setTrashModalOpen(false);
        setTrashItems([]);
        setTrashTotal(0);
        setTrashPurgedCount(0);
        setTrashLoadError('');
        setTrashLoading(false);
        setTrashActionLoadingId('');
        setSelectedTrashDocumentIds([]);
        setTrashBulkActionLoading(false);
        setTrashPage(1);
        setTrashPageSize(TRASH_PAGE_SIZE_OPTIONS[1]);
        setTrashSort('deleted_newest');
        setTrashQuery('');
        setActiveDoc(null);
        setActiveDocError('');
        setActiveDocLoading(false);
        setActiveDocFileVersion(0);
        setActiveDocEditMode(false);
        setActiveDocDraftHtml('');
        setActiveDocSaveError('');
        clearActiveDocShareState();
      }
      closeWorkspaceDialogs();

      const nextWorkspaceState = await refreshWorkspaces({
        preserveActive: !removingActiveWorkspace,
        preferredWorkspaceId: removingActiveWorkspace ? '' : activeWorkspaceId,
      });
      const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
      if (warnings.length) {
        showToast(
          `Deleted workspace "${workspaceLabel}". Some files could not be removed from storage.`,
          'warning'
        );
      } else {
        const nextWorkspace = removingActiveWorkspace
          ? (nextWorkspaceState?.workspaces || []).find(
              (item) => item.id === nextWorkspaceState?.activeWorkspaceId
            ) ||
            nextWorkspaceState?.workspaces?.[0] ||
            null
          : null;
        const followup = nextWorkspace?.name ? ` Switched to "${nextWorkspace.name}".` : '';
        showToast(`Deleted workspace "${workspaceLabel}".${followup}`, 'success');
      }
    } catch (err) {
      showToast(err.message || 'Failed to delete workspace', 'error');
    } finally {
      setWorkspaceActionLoading(false);
    }
  };

  const handleLeaveWorkspace = async (workspaceToLeave = activeWorkspace) => {
    const targetWorkspace = workspaceToLeave || activeWorkspace;
    const targetWorkspaceId = String(targetWorkspace?.id || '').trim();
    if (!targetWorkspaceId || !username || !isLoggedIn) {
      showToast('Please sign in first.', 'warning');
      return;
    }
    if (targetWorkspace?.is_owner !== false) {
      showToast('Use Delete for workspaces you own.', 'warning');
      return;
    }

    const workspaceLabel = String(targetWorkspace?.name || 'this workspace').trim();
    const confirmed = await requestConfirmation({
      title: 'Remove Workspace',
      description: `Remove "${workspaceLabel}" from your account? You will lose access to its files unless the owner invites you again.`,
      confirmLabel: 'Remove Workspace',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!confirmed) return;

    setWorkspaceActionLoading(true);
    try {
      const removingActiveWorkspace = targetWorkspaceId === activeWorkspaceId;
      const res = await authFetch(
        `/api/workspaces/${encodeURIComponent(targetWorkspaceId)}/members/${encodeURIComponent(username)}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username }),
        },
        { authToken }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to leave workspace');

      if (removingActiveWorkspace) {
        resetDocumentsData();
        setSidebarRecentIds([]);
        setSidebarRecentMeta({});
        setStarredNotes([]);
        setSummaryHistory([]);
        setSummaryCenterOpen(false);
        setSummaryCenterQuery('');
        setSidebarMenuDocId(null);
        setActiveDoc(null);
        setActiveDocError('');
        setActiveDocLoading(false);
        setActiveDocFileVersion(0);
        setActiveDocEditMode(false);
        setActiveDocDraftHtml('');
        setActiveDocSaveError('');
        clearActiveDocShareState();
      }
      closeWorkspaceDialogs();

      const nextWorkspaceState = await refreshWorkspaces({
        preserveActive: !removingActiveWorkspace,
        preferredWorkspaceId: removingActiveWorkspace ? '' : activeWorkspaceId,
      });
      const nextWorkspace = removingActiveWorkspace
        ? (nextWorkspaceState?.workspaces || []).find(
            (item) => item.id === nextWorkspaceState?.activeWorkspaceId
          ) ||
          nextWorkspaceState?.workspaces?.[0] ||
          null
        : null;
      const followup = nextWorkspace?.name ? ` Switched to "${nextWorkspace.name}".` : '';
      showToast(`Removed workspace "${workspaceLabel}".${followup}`, 'success');
    } catch (err) {
      showToast(err.message || 'Failed to remove workspace', 'error');
    } finally {
      setWorkspaceActionLoading(false);
    }
  };

  const openDocumentInPane = async (docId, options = {}) => {
    const { fromSidebar = false, seedDoc = null } = options;
    bumpSidebarRecent(seedDoc || docId);
    setActiveDocLoading(true);
    setActiveDocError('');
    setActiveDocFileVersion(0);
    setActiveDocEditMode(false);
    setActiveDocDraftHtml('');
    setActiveDocSaveError('');
    setPdfConversionDraft(null);
    setPdfConversionChoiceOpen(false);
    setPdfConversionLoading(false);
    setPdfConversionMode('simple');
    setPdfConversionOutputFormat('docx');
    setPdfConversionSaveMode('replace');
    setPdfConversionTitle('');
    setSidebarMenuDocId(null);
    setActiveDoc(null);
    clearActiveDocShareState();

    if (fromSidebar) {
      // Sidebar click should open the document pane directly, not stay in file-list mode.
      setShowFiles(false);
      window.requestAnimationFrame(() => {
        document.getElementById('main')?.scrollIntoView({ block: 'start' });
      });
    }
    try {
      const params = new URLSearchParams();
      if (username) params.set('username', username);
      const endpoint = params.toString()
        ? `/api/documents/${docId}?${params.toString()}`
        : `/api/documents/${docId}`;
      const res = await authFetch(endpoint, {}, { authToken });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Document not found');
      const normalizedDoc = normalizeDocument(data);
      setActiveDoc(normalizedDoc);
      bumpSidebarRecent(normalizedDoc);
      setActiveDocFileVersion(Date.now());
    } catch (err) {
      setActiveDoc(null);
      setActiveDocError(err.message || 'Failed to load document');
    } finally {
      setActiveDocLoading(false);
    }
  };

  const handleView = (doc) => {
    openDocumentInPane(doc.id, { seedDoc: doc });
  };

  const toggleDocumentSelection = (docId) => {
    const nextId = Number(docId);
    if (!Number.isFinite(nextId)) return;
    setSelectedDocumentIds((prev) => {
      if (prev.includes(nextId)) {
        return prev.filter((id) => id !== nextId);
      }
      return [...prev, nextId];
    });
  };

  const toggleSelectAllDocumentsOnPage = () => {
    if (!visibleDocumentIds.length) return;
    setSelectedDocumentIds((prev) => {
      const prevSet = new Set(prev);
      const shouldUnselect = visibleDocumentIds.every((id) => prevSet.has(id));
      if (shouldUnselect) {
        return prev.filter((id) => !visibleDocumentIdSet.has(Number(id)));
      }
      visibleDocumentIds.forEach((id) => prevSet.add(id));
      return Array.from(prevSet);
    });
  };

  const handleSelectAllMatchedDocuments = async () => {
    if (!username || !authToken || !activeWorkspaceId) {
      showToast('Please sign in first.', 'warning');
      return;
    }
    if (!documentsTotal) {
      showToast('No documents match the current filters.', 'warning');
      return;
    }

    setSelectAllMatchedLoading(true);
    try {
      const fetchedIds = [];
      let offset = 0;
      let matchedTotal = Number(documentsTotal) || 0;

      while (fetchedIds.length < BULK_SELECT_MAX_ITEMS) {
        const params = buildDocumentsQueryParams({
          limit: BULK_SELECT_BATCH_SIZE,
          offset,
          sort: documentsSort,
          includeMeta: false,
          includeFacets: false,
        });
        const res = await authFetch(`/api/documents?${params.toString()}`, {}, { authToken });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || 'Failed to load matching documents');

        const items = Array.isArray(payload?.items) ? payload.items : [];
        const total = Number(payload?.total);
        if (Number.isFinite(total) && total >= 0) matchedTotal = total;

        if (!items.length) break;

        items.forEach((item) => {
          const nextId = Number(item?.id);
          if (Number.isFinite(nextId)) fetchedIds.push(nextId);
        });
        offset += items.length;

        if (offset >= matchedTotal) break;
      }

      const uniqueIds = Array.from(new Set(fetchedIds)).slice(0, BULK_SELECT_MAX_ITEMS);
      setSelectedDocumentIds(uniqueIds);
      setBulkResultSummary(DEFAULT_BULK_RESULT_SUMMARY);

      if (!uniqueIds.length) {
        showToast('No selectable documents found for current filters.', 'warning');
        return;
      }

      const reachedLimit = matchedTotal > BULK_SELECT_MAX_ITEMS || uniqueIds.length >= BULK_SELECT_MAX_ITEMS;
      if (reachedLimit) {
        showToast(
          `Selected first ${uniqueIds.length} matched note(s). Refine filters to target more precisely.`,
          'warning'
        );
      } else {
        showToast(`Selected ${uniqueIds.length} matched note(s) across pages.`, 'success');
      }
    } catch (err) {
      showToast(err.message || 'Failed to select matched documents.', 'error');
    } finally {
      setSelectAllMatchedLoading(false);
    }
  };

  const clearSelectedDocuments = () => {
    setSelectedDocumentIds([]);
  };

  const dismissBulkResultSummary = () => {
    setBulkResultSummary(DEFAULT_BULK_RESULT_SUMMARY);
  };

  const dismissToast = () => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToastState((prev) => ({ ...prev, open: false }));
  };

  const handleOpenTrashModal = () => {
    setTrashModalOpen(true);
  };

  const toggleTrashDocumentSelection = (docId) => {
    const safeId = toPositiveDocId(docId);
    if (!safeId) return;
    setSelectedTrashDocumentIds((prev) => {
      const has = prev.some((id) => toPositiveDocId(id) === safeId);
      if (has) {
        return prev.filter((id) => toPositiveDocId(id) !== safeId);
      }
      return [...prev, safeId];
    });
  };

  const toggleSelectAllTrashOnPage = () => {
    const visibleIds = trashItems
      .map((item) => toPositiveDocId(item?.id))
      .filter(Boolean);
    if (!visibleIds.length) return;
    if (allTrashItemsSelectedOnPage) {
      setSelectedTrashDocumentIds((prev) =>
        prev.filter((id) => !visibleIds.includes(toPositiveDocId(id)))
      );
      return;
    }
    setSelectedTrashDocumentIds((prev) => {
      const merged = new Set(prev.map((id) => toPositiveDocId(id)).filter(Boolean));
      visibleIds.forEach((id) => merged.add(id));
      return Array.from(merged);
    });
  };

  const clearSelectedTrashDocuments = () => {
    setSelectedTrashDocumentIds([]);
  };

  const handleBulkRestoreFromTrash = async () => {
    const selectedIds = Array.from(new Set(
      selectedTrashDocumentIds.map((id) => toPositiveDocId(id)).filter(Boolean)
    ));
    if (!selectedIds.length) {
      showToast('Please select at least one trashed document.', 'warning');
      return;
    }

    setTrashBulkActionLoading(true);
    try {
      const results = await Promise.all(selectedIds.map(async (docId) => {
        try {
          const res = await authFetch(`/api/documents/${docId}/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username || '' }),
          }, { authToken });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Restore failed');
          return { id: docId, ok: true };
        } catch (err) {
          return { id: docId, ok: false, message: err?.message || 'Restore failed' };
        }
      }));

      const successIds = results.filter((item) => item.ok).map((item) => toPositiveDocId(item.id)).filter(Boolean);
      const failedCount = results.length - successIds.length;
      const shouldMoveToPreviousTrashPage =
        trashPage > 1 && successIds.length > 0 && successIds.length >= trashItems.length;

      if (successIds.length) {
        await fetchDocuments(documentsPage);
      }
      setSelectedTrashDocumentIds((prev) =>
        prev.filter((id) => !successIds.includes(toPositiveDocId(id)))
      );

      if (shouldMoveToPreviousTrashPage) {
        setTrashPage((prev) => Math.max(1, prev - 1));
      } else {
        void fetchTrashDocuments({ silent: true });
      }

      if (failedCount) {
        showToast(`Restore selected: ${successIds.length} succeeded, ${failedCount} failed.`, 'warning');
      } else {
        showToast(`Restored ${successIds.length} document(s).`, 'success');
      }
    } finally {
      setTrashBulkActionLoading(false);
    }
  };

  const handleBulkDeleteForeverFromTrash = async () => {
    const selectedIds = Array.from(new Set(
      selectedTrashDocumentIds.map((id) => toPositiveDocId(id)).filter(Boolean)
    ));
    if (!selectedIds.length) {
      showToast('Please select at least one trashed document.', 'warning');
      return;
    }

    const confirmed = await requestConfirmation({
      title: `Delete ${selectedIds.length} selected item(s) forever?`,
      description: 'This removes files and metadata permanently.',
      confirmLabel: 'Delete Forever',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!confirmed) return;

    setTrashBulkActionLoading(true);
    try {
      const results = await Promise.all(selectedIds.map(async (docId) => {
        try {
          const res = await authFetch(`/api/documents/${docId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username || '', permanent: true }),
          }, { authToken });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Permanent delete failed');
          return { id: docId, ok: true, warning: String(data.warning || '').trim() };
        } catch (err) {
          return { id: docId, ok: false, message: err?.message || 'Permanent delete failed' };
        }
      }));

      const successItems = results.filter((item) => item.ok);
      const successIds = successItems.map((item) => toPositiveDocId(item.id)).filter(Boolean);
      const failedCount = results.length - successIds.length;
      const warningCount = successItems.filter((item) => item.warning).length;
      const shouldMoveToPreviousTrashPage =
        trashPage > 1 && successIds.length > 0 && successIds.length >= trashItems.length;

      successIds.forEach((docId) => {
        removeDocumentFromClientState(docId);
      });
      if (successIds.length) {
        await fetchDocuments(documentsPage);
      }

      setSelectedTrashDocumentIds((prev) =>
        prev.filter((id) => !successIds.includes(toPositiveDocId(id)))
      );

      if (shouldMoveToPreviousTrashPage) {
        setTrashPage((prev) => Math.max(1, prev - 1));
      } else {
        void fetchTrashDocuments({ silent: true });
      }

      if (failedCount) {
        showToast(`Delete forever: ${successIds.length} succeeded, ${failedCount} failed.`, 'warning');
      } else if (warningCount) {
        showToast(`Deleted ${successIds.length} item(s). ${warningCount} storage warning(s).`, 'warning');
      } else {
        showToast(`Deleted ${successIds.length} item(s) permanently.`, 'success');
      }
    } finally {
      setTrashBulkActionLoading(false);
    }
  };

  const handleRestoreFromTrash = async (doc) => {
    const docId = toPositiveDocId(doc?.id);
    if (!docId) return;
    const shouldMoveToPreviousTrashPage = trashPage > 1 && trashItems.length <= 1;
    setTrashActionLoadingId(`restore-${docId}`);
    try {
      const res = await authFetch(`/api/documents/${docId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username || '' }),
      }, { authToken });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Restore failed');

      await fetchDocuments(documentsPage);
      if (shouldMoveToPreviousTrashPage) {
        setTrashPage((prev) => Math.max(1, prev - 1));
      } else {
        void fetchTrashDocuments({ silent: true });
      }
      showToast(data.message || 'Document restored.', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to restore document.', 'error');
    } finally {
      setTrashActionLoadingId('');
    }
  };

  const handleDeleteForeverFromTrash = async (doc) => {
    const docId = toPositiveDocId(doc?.id);
    if (!docId) return;
    const shouldMoveToPreviousTrashPage = trashPage > 1 && trashItems.length <= 1;
    const shouldDelete = await requestConfirmation({
      title: `Delete "${doc?.title || `Note ${docId}`}" forever?`,
      description: 'This removes the file and metadata permanently.',
      confirmLabel: 'Delete Forever',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!shouldDelete) return;

    setTrashActionLoadingId(`delete-${docId}`);
    try {
      const res = await authFetch(`/api/documents/${docId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username || '', permanent: true }),
      }, { authToken });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Permanent delete failed');

      removeDocumentFromClientState(docId);
      await fetchDocuments(documentsPage);
      if (shouldMoveToPreviousTrashPage) {
        setTrashPage((prev) => Math.max(1, prev - 1));
      } else {
        void fetchTrashDocuments({ silent: true });
      }
      if (data.warning) {
        showToast(`Deleted permanently. ${data.warning}`, 'warning');
      } else {
        showToast(data.message || 'Document deleted permanently.', 'success');
      }
    } catch (err) {
      showToast(err.message || 'Failed to delete permanently.', 'error');
    } finally {
      setTrashActionLoadingId('');
    }
  };

  const handleDelete = async (doc) => {
    const shouldDelete = await requestConfirmation({
      title: `Move "${doc.title}" to Trash?`,
      description: `This note will stay in Trash for ${trashRetentionDays} day(s) before auto-delete.`,
      confirmLabel: 'Move to Trash',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!shouldDelete) return;
    try {
      const res = await authFetch(`/api/documents/${doc.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username || '' }),
      }, { authToken });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Move to Trash failed');

      const removedId = toPositiveDocId(doc.id);
      const nextTotal = Math.max(0, (Number(documentsTotal) || 0) - 1);
      const shouldMoveToPreviousPage = documentsPage > 1 && documents.length <= 1;

      removeDocumentFromClientState(removedId);
      setDocumentsTotal(nextTotal);
      if (shouldMoveToPreviousPage) {
        setDocumentsPage((prev) => Math.max(1, prev - 1));
      } else {
        await fetchDocuments(documentsPage);
      }
      if (trashModalOpen) {
        void fetchTrashDocuments({ silent: true });
      }
      showToast(data.message || 'Document moved to Trash.', data.already_deleted ? 'info' : 'success');
    } catch (err) {
      showToast(err.message || 'Move to Trash failed', 'error');
    }
  };

  const runBulkAction = async (label, worker, options = {}) => {
    const selectedIds = Array.from(new Set(selectedDocumentIds.map((id) => Number(id))))
      .filter((id) => Number.isFinite(id));
    if (!selectedIds.length) {
      showToast('Please select at least one document.', 'warning');
      return [];
    }

    setBulkActionLoading(true);
    try {
      const results = await Promise.all(selectedIds.map(async (id) => {
        try {
          const data = await worker(id);
          return { id, ok: true, data };
        } catch (err) {
          return { id, ok: false, message: err?.message || 'Unknown error' };
        }
      }));

      const successItems = results.filter((item) => item.ok);
      const failedItems = results.filter((item) => !item.ok);
      const successIds = successItems.map((item) => Number(item.id));

      if (options.clearSelectedOnSuccess) {
        setSelectedDocumentIds((prev) =>
          prev.filter((id) => !successIds.includes(Number(id)))
        );
      }

      if (options.removeRecentOnSuccess) {
        setSidebarRecentIds((prev) => prev.filter((id) => !successIds.includes(Number(id))));
        setSidebarRecentMeta((prev) => {
          const next = { ...(prev || {}) };
          successIds.forEach((id) => {
            delete next[id];
          });
          return next;
        });
      }
      if (options.removeStarredOnSuccess) {
        setStarredNotes((prev) =>
          prev.filter((item) => !successIds.includes(toPositiveDocId(item.id)))
        );
      }
      if (options.removeSummariesOnSuccess) {
        setSummaryHistory((prev) =>
          prev.filter((item) => !successIds.includes(toPositiveDocId(item.docId)))
        );
      }

      if (typeof options.afterSuccess === 'function' && successItems.length) {
        options.afterSuccess(successItems);
      }

      await fetchDocuments(documentsPage);

      const failedPreview = failedItems.slice(0, 12).map((item) => ({
        id: Number(item.id),
        message: String(item.message || 'Unknown error'),
      }));
      setBulkResultSummary({
        action: label,
        total: selectedIds.length,
        succeeded: successItems.length,
        failed: failedItems.length,
        failedItems: failedPreview,
        hiddenFailedCount: Math.max(0, failedItems.length - failedPreview.length),
        updatedAt: new Date().toISOString(),
      });

      if (failedItems.length) {
        showToast(`${label}: ${successItems.length} succeeded, ${failedItems.length} failed.`, 'warning');
      } else {
        showToast(`${label}: ${successItems.length} succeeded.`, 'success');
      }
      return successItems;
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleBulkDelete = async () => {
    const selectedCount = selectedDocumentIds.length;
    if (!selectedCount) {
      showToast('Please select at least one document.', 'warning');
      return;
    }
    const shouldDelete = await requestConfirmation({
      title: `Move ${selectedCount} selected note(s) to Trash?`,
      description: `You can restore items from Trash within ${trashRetentionDays} day(s).`,
      confirmLabel: 'Move to Trash',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!shouldDelete) return;

    const successItems = await runBulkAction(
      'Move selected documents to Trash',
      async (docId) => {
        const res = await authFetch(`/api/documents/${docId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username || '' }),
        }, { authToken });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Move to Trash failed');
        return data;
      },
      {
        clearSelectedOnSuccess: true,
        removeRecentOnSuccess: true,
        removeStarredOnSuccess: true,
        removeSummariesOnSuccess: true,
        afterSuccess: (items) => {
          const removedIdSet = new Set(items.map((item) => Number(item.id)));
          if (activeDoc && removedIdSet.has(Number(activeDoc.id))) {
            clearActiveDocShareState();
            setActiveDoc(null);
          }
        },
      }
    );
    if (successItems.length && trashModalOpen) {
      void fetchTrashDocuments({ silent: true });
    }
  };

  const handleBulkApplyCategory = async () => {
    if (!activeWorkspaceSettings.allow_note_editing) {
      showToast('Editing is disabled in this workspace settings.', 'warning');
      return;
    }

    const nextCategory = bulkCategoryDraft.trim();
    await runBulkAction(
      'Update category',
      async (docId) => {
        const res = await authFetch(`/api/documents/${docId}/category`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: nextCategory, username: username || '' }),
        }, { authToken });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to update category');
        return normalizeDocument(data);
      },
      {
        afterSuccess: (items) => {
          const normalizedMap = new Map(
            items
              .map((item) => [Number(item.id), item.data])
              .filter(([id, value]) => Number.isFinite(id) && value)
          );
          if (!normalizedMap.size) return;
          setDocuments((prev) =>
            prev.map((item) => normalizedMap.get(Number(item.id)) || item)
          );
          setActiveDoc((prev) => {
            if (!prev) return prev;
            return normalizedMap.get(Number(prev.id)) || prev;
          });
        },
      }
    );
  };

  const handleBulkApplyTags = async () => {
    if (!activeWorkspaceSettings.allow_note_editing) {
      showToast('Editing is disabled in this workspace settings.', 'warning');
      return;
    }

    const nextTags = bulkTagsDraft
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (!nextTags.length) {
      const confirmClear = await requestConfirmation({
        title: 'Clear tags for selected notes?',
        description: 'Tag input is empty, so all selected notes will have no tags.',
        confirmLabel: 'Clear Tags',
        cancelLabel: 'Cancel',
        danger: true,
      });
      if (!confirmClear) return;
    }

    await runBulkAction(
      'Update tags',
      async (docId) => {
        const res = await authFetch(`/api/documents/${docId}/tags`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: nextTags, username: username || '' }),
        }, { authToken });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to update tags');
        return normalizeDocument(data);
      },
      {
        afterSuccess: (items) => {
          const normalizedMap = new Map(
            items
              .map((item) => [Number(item.id), item.data])
              .filter(([id, value]) => Number.isFinite(id) && value)
          );
          if (!normalizedMap.size) return;
          setDocuments((prev) =>
            prev.map((item) => normalizedMap.get(Number(item.id)) || item)
          );
          setActiveDoc((prev) => {
            if (!prev) return prev;
            return normalizedMap.get(Number(prev.id)) || prev;
          });
        },
      }
    );
  };

  const handleBulkSummarizeSelected = async (options = {}) => {
    const forceRefresh = Boolean(options?.forceRefresh);
    if (!activeWorkspaceSettings.allow_ai_tools) {
      showToast('AI tools are disabled in this workspace settings.', 'warning');
      return;
    }
    const selectedIds = Array.from(new Set(selectedDocumentIds.map((id) => toPositiveDocId(id)))).filter(Boolean);
    if (!selectedIds.length) {
      showToast('Please select at least one document.', 'warning');
      return;
    }
    const docMap = new Map(
      documents
        .map((item) => [toPositiveDocId(item.id), item])
        .filter(([id]) => id > 0)
    );
    const successItems = await runBulkAction(
      forceRefresh ? 'Regenerate summaries' : 'Generate summaries',
      async (docId) => {
        const data = await requestSummary({
          docId,
          text: '',
          trackLoading: false,
          silentError: true,
          forceRefresh,
        });
        if (!data) throw new Error('Summary failed');
        return data;
      },
      {
        afterSuccess: (items) => {
          if (!items.length) return;
          const entries = items
            .map((item) => {
              const safeId = toPositiveDocId(item.id);
              return toSummaryHistoryEntry(docMap.get(safeId) || { id: safeId }, item.data, { docId: safeId });
            })
            .filter(Boolean);
          if (!entries.length) return;
          setSummaryHistory((prev) => {
            const byId = new Map(prev.map((entry) => [String(entry.id), entry]));
            entries.forEach((entry) => {
              byId.set(String(entry.id), entry);
            });
            return Array.from(byId.values())
              .sort((a, b) => toTimeMs(b.generatedAt) - toTimeMs(a.generatedAt))
              .slice(0, MAX_SUMMARY_HISTORY_PER_WORKSPACE);
          });
        },
      }
    );
    if (successItems.length) {
      setSummaryCenterOpen(true);
    }
  };

  const handleBulkAddToStarred = () => {
    const selectedIds = Array.from(new Set(selectedDocumentIds.map((id) => toPositiveDocId(id)))).filter(Boolean);
    if (!selectedIds.length) {
      showToast('Please select at least one document.', 'warning');
      return;
    }
    if (bulkActionLoading || documentsLoading || selectAllMatchedLoading) return;
    setBulkActionLoading(true);
    try {
      const docMap = new Map(
        documents
          .map((item) => [toPositiveDocId(item.id), item])
          .filter(([id]) => id > 0)
      );
      const nowIso = new Date().toISOString();
      const existingSet = new Set(starredNotes.map((item) => toPositiveDocId(item.id)).filter(Boolean));
      const addedIds = [];
      const skippedIds = [];
      let nextList = starredNotes.slice();
      selectedIds.forEach((id) => {
        if (existingSet.has(id)) {
          skippedIds.push(id);
          return;
        }
        const doc = docMap.get(id);
        const entry = toStarredEntry(doc || { id, title: `Note ${id}` });
        if (!entry) {
          skippedIds.push(id);
          return;
        }
        entry.updatedAt = nowIso;
        existingSet.add(id);
        addedIds.push(id);
        nextList.unshift(entry);
      });
      let droppedCount = 0;
      if (nextList.length > MAX_STARRED_NOTES_PER_WORKSPACE) {
        droppedCount = nextList.length - MAX_STARRED_NOTES_PER_WORKSPACE;
        nextList = nextList.slice(0, MAX_STARRED_NOTES_PER_WORKSPACE);
      }
      setStarredNotes(nextList);

      setBulkResultSummary({
        action: 'Add to Starred',
        total: selectedIds.length,
        succeeded: addedIds.length,
        failed: 0,
        failedItems: [],
        hiddenFailedCount: 0,
        updatedAt: new Date().toISOString(),
      });

      if (!addedIds.length) {
        showToast('All selected notes are already starred.', 'info');
      } else if (skippedIds.length || droppedCount > 0) {
        const parts = [`Added ${addedIds.length} note(s) to Starred.`];
        if (skippedIds.length) parts.push(`${skippedIds.length} already starred.`);
        if (droppedCount > 0) parts.push(`Trimmed ${droppedCount} old starred note(s).`);
        showToast(parts.join(' '), 'warning');
      } else {
        showToast(`Added ${addedIds.length} note(s) to Starred.`, 'success');
      }
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleBulkRemoveFromStarred = () => {
    const selectedIds = Array.from(new Set(selectedDocumentIds.map((id) => toPositiveDocId(id)))).filter(Boolean);
    if (!selectedIds.length) {
      showToast('Please select at least one document.', 'warning');
      return;
    }
    if (bulkActionLoading || documentsLoading || selectAllMatchedLoading) return;
    setBulkActionLoading(true);
    try {
      const selectedSet = new Set(selectedIds);
      const removed = starredNotes.filter((item) => selectedSet.has(toPositiveDocId(item.id))).length;
      if (!removed) {
        setBulkResultSummary({
          action: 'Remove from Starred',
          total: selectedIds.length,
          succeeded: 0,
          failed: 0,
          failedItems: [],
          hiddenFailedCount: 0,
          updatedAt: new Date().toISOString(),
        });
        showToast('No selected notes were starred.', 'info');
        return;
      }
      setStarredNotes((prev) => prev.filter((item) => !selectedSet.has(toPositiveDocId(item.id))));
      setBulkResultSummary({
        action: 'Remove from Starred',
        total: selectedIds.length,
        succeeded: removed,
        failed: 0,
        failedItems: [],
        hiddenFailedCount: 0,
        updatedAt: new Date().toISOString(),
      });
      showToast(`Removed ${removed} note(s) from Starred.`, 'success');
    } finally {
      setBulkActionLoading(false);
    }
  };

  const applyUpdatedDocument = (rawDocument) => {
    const normalized = normalizeDocument(rawDocument);
    const docId = toPositiveDocId(normalized.id);
    if (!docId) return normalized;

    setDocuments((prev) => prev.map((item) => (toPositiveDocId(item.id) === docId ? normalized : item)));
    setActiveDoc((prev) => (toPositiveDocId(prev?.id) === docId ? normalized : prev));
    setSidebarRecentMeta((prev) => {
      if (!prev?.[docId]) return prev;
      return {
        ...prev,
        [docId]: {
          ...prev[docId],
          title: normalized.title,
          fileType: String(getDocExt(normalized) || '').trim().toLowerCase(),
          updatedAt: new Date().toISOString(),
        },
      };
    });
    setStarredNotes((prev) => prev.map((entry) => (
      toPositiveDocId(entry.id) === docId
        ? {
            ...entry,
            title: normalized.title,
            fileType: String(getDocExt(normalized) || '').trim().toLowerCase(),
            updatedAt: new Date().toISOString(),
          }
        : entry
    )));
    setSummaryHistory((prev) => prev.map((entry) => (
      toPositiveDocId(entry.docId) === docId ? { ...entry, title: normalized.title } : entry
    )));
    return normalized;
  };

  const handleRenameDocument = async (doc) => {
    if (!activeWorkspaceSettings.allow_note_editing) {
      showToast('Editing is disabled in this workspace settings.', 'warning');
      return;
    }
    const currentTitle = String(doc?.title || '').trim();
    const input = await requestTextInput({
      title: 'Rename Note',
      description: 'Change the name shown in StudyHub. The stored file stays unchanged.',
      placeholder: 'e.g. Lecture notes.pdf',
      initialValue: currentTitle,
      confirmLabel: 'Save',
      cancelLabel: 'Cancel',
      required: true,
      trimResult: true,
    });
    if (input === null) return;
    const nextTitle = String(input || '').trim();
    if (!nextTitle || nextTitle === currentTitle) return;

    try {
      const res = await authFetch(`/api/documents/${doc.id}/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: nextTitle, username: username || '' }),
      }, { authToken });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to rename note');

      const normalized = applyUpdatedDocument(data);
      showToast(`Renamed to "${normalized.title}".`, 'success');
    } catch (err) {
      showToast(err.message || 'Failed to rename note', 'error');
    }
  };

  const handleEdit = async (doc) => {
    if (!activeWorkspaceSettings.allow_note_editing) {
      showToast('Editing is disabled in this workspace settings.', 'warning');
      return;
    }
    const input = await requestTextInput({
      title: 'Edit Tags',
      description: 'Enter tags separated by commas.',
      placeholder: 'e.g. exam, chapter-3',
      initialValue: (doc.tags || []).join(', '),
      confirmLabel: 'Save',
      cancelLabel: 'Cancel',
      trimResult: false,
    });
    if (input === null) return;
    const nextTags = input
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);

    try {
      const res = await authFetch(`/api/documents/${doc.id}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: nextTags, username: username || '' }),
      }, { authToken });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update tags');

      applyUpdatedDocument(data);
    } catch (err) {
      showToast(err.message || 'Failed to update tags', 'error');
    }
  };

  const handleEditCategory = async (doc) => {
    if (!activeWorkspaceSettings.allow_note_editing) {
      showToast('Editing is disabled in this workspace settings.', 'warning');
      return;
    }
    const current = normalizeCategory(doc.category);
    const input = await requestTextInput({
      title: 'Edit Category',
      description: 'Leave empty to reset as Uncategorized.',
      placeholder: 'e.g. Computer Science',
      initialValue: current === DEFAULT_NOTE_CATEGORY ? '' : current,
      confirmLabel: 'Save',
      cancelLabel: 'Cancel',
      trimResult: true,
    });
    if (input === null) return;
    const nextCategory = input.trim();

    try {
      const res = await authFetch(`/api/documents/${doc.id}/category`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: nextCategory, username: username || '' }),
      }, { authToken });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update category');

      applyUpdatedDocument(data);
    } catch (err) {
      showToast(err.message || 'Failed to update category', 'error');
    }
  };

  const handleSaveActiveDocContent = async () => {
    if (!activeDoc) return;
    if (!activeWorkspaceSettings.allow_note_editing) {
      setActiveDocSaveError('Editing is disabled in this workspace settings.');
      return;
    }
    const targetDocId = Number(activeDoc.id);
    setActiveDocSaveLoading(true);
    setActiveDocSaveError('');

    try {
      const contentHtml = activeDocDraftHtml || '';
      const contentText = richHtmlToPlainText(contentHtml);
      const res = await authFetch(`/api/documents/${activeDoc.id}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: contentText,
          content_html: contentHtml,
          username: username || '',
        }),
      }, { authToken });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save document content');

      const normalized = normalizeDocument(data);
      setActiveDoc((prev) => (Number(prev?.id) === targetDocId ? normalized : prev));
      setDocuments((prev) =>
        prev.map((item) =>
          Number(item.id) === targetDocId ? normalized : item
        )
      );
      if (typeof data.content_html === 'string') {
        setActiveDocDraftHtml(data.content_html);
      } else if (typeof data.content === 'string') {
        setActiveDocDraftHtml(plainTextToRichHtml(data.content));
      }
      setActiveDocFileVersion(Date.now());
      setActiveDocEditMode(false);
    } catch (err) {
      setActiveDocSaveError(err.message || 'Failed to save document content');
    } finally {
      setActiveDocSaveLoading(false);
    }
  };

  const handleSaveActivePdfFile = async (pdfBytes) => {
    if (!activeDoc) throw new Error('No active document selected');
    if (!activeWorkspaceSettings.allow_note_editing) {
      throw new Error('Editing is disabled in this workspace settings.');
    }
    const targetDocId = Number(activeDoc.id);
    setActiveDocSaveLoading(true);
    setActiveDocSaveError('');

    try {
      const payload = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
      const query = username ? `?username=${encodeURIComponent(username)}` : '';
      const res = await authFetch(`/api/documents/${activeDoc.id}/pdf${query}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: payload,
      }, { authToken });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save PDF file');

      const normalized = normalizeDocument(data);
      setActiveDoc((prev) => (Number(prev?.id) === targetDocId ? normalized : prev));
      setDocuments((prev) =>
        prev.map((item) =>
          Number(item.id) === targetDocId ? normalized : item
        )
      );
      setActiveDocFileVersion(Date.now());
      return data;
    } catch (err) {
      const message = err.message || 'Failed to save PDF';
      setActiveDocSaveError(message);
      throw err;
    } finally {
      setActiveDocSaveLoading(false);
    }
  };

  const handleOpenPdfConversionChoices = () => {
    if (!activeDoc) return;
    if (!activeDocIsPdf) {
      showToast('Only PDF notes can be converted to an editable draft.', 'warning');
      return;
    }
    if (!isLoggedIn) {
      showToast('Please sign in before converting a PDF.', 'warning');
      return;
    }
    if (!activeWorkspaceSettings.allow_note_editing) {
      showToast('Editing is disabled in this workspace settings.', 'warning');
      return;
    }
    setActiveDocSaveError('');
    setPdfConversionChoiceOpen((open) => !open);
  };

  const handleStartPdfConversion = async (mode = 'simple') => {
    if (!activeDoc) return;
    if (!activeDocIsPdf) {
      showToast('Only PDF notes can be converted to an editable draft.', 'warning');
      return;
    }
    if (!isLoggedIn) {
      showToast('Please sign in before converting a PDF.', 'warning');
      return;
    }
    if (!activeWorkspaceSettings.allow_note_editing) {
      showToast('Editing is disabled in this workspace settings.', 'warning');
      return;
    }

    const safeMode = mode === 'layout' ? 'layout' : 'simple';
    setPdfConversionChoiceOpen(false);
    setPdfConversionLoading(true);
    setPdfConversionMode(safeMode);
    setActiveDocSaveError('');

    try {
      const res = await authFetch(`/api/documents/${activeDoc.id}/convert-to-editable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: safeMode, username: username || '' }),
      }, { authToken });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to convert PDF');

      const draftHtml = data.content_html || plainTextToRichHtml(data.content || '');
      setPdfConversionDraft(data);
      setPdfConversionOutputFormat('docx');
      setPdfConversionSaveMode('replace');
      setPdfConversionTitle(data.suggested_docx_title || replaceFileExtension(activeDoc.title || activeDoc.filename, 'docx'));
      setActiveDocDraftHtml(draftHtml);
      showToast(
        safeMode === 'layout'
          ? 'Layout draft created. Review the formatting before saving.'
          : 'Editable draft created. Review it before saving.',
        'success'
      );
    } catch (err) {
      setPdfConversionDraft(null);
      setPdfConversionChoiceOpen(false);
      setActiveDocSaveError(err.message || 'Failed to convert PDF');
      showToast(err.message || 'Failed to convert PDF', 'error');
    } finally {
      setPdfConversionLoading(false);
    }
  };

  const handleChangePdfConversionOutputFormat = (nextFormat) => {
    const safeFormat = nextFormat === 'pdf' ? 'pdf' : 'docx';
    setPdfConversionOutputFormat(safeFormat);
    setPdfConversionTitle((prev) => {
      const fallbackTitle = safeFormat === 'pdf'
        ? pdfConversionDraft?.suggested_pdf_title
        : pdfConversionDraft?.suggested_docx_title;
      return replaceFileExtension(prev || fallbackTitle || activeDoc?.title || activeDoc?.filename, safeFormat);
    });
  };

  const handleDiscardPdfConversionDraft = () => {
    setPdfConversionDraft(null);
    setPdfConversionChoiceOpen(false);
    setPdfConversionLoading(false);
    setPdfConversionMode('simple');
    setPdfConversionOutputFormat('docx');
    setPdfConversionSaveMode('replace');
    setPdfConversionTitle('');
    setActiveDocSaveError('');
    setActiveDocDraftHtml(getDocumentRichHtml(activeDoc));
  };

  const handleSavePdfConversionDraft = async () => {
    if (!activeDoc || !pdfConversionDraft) return;
    if (!activeWorkspaceSettings.allow_note_editing) {
      setActiveDocSaveError('Editing is disabled in this workspace settings.');
      return;
    }

    const saveMode = pdfConversionSaveMode === 'copy' ? 'copy' : 'replace';
    const outputFormat = pdfConversionOutputFormat === 'pdf' ? 'pdf' : 'docx';
    if (saveMode === 'replace') {
      const confirmed = await requestConfirmation({
        title: 'Replace original PDF?',
        description: 'The current PDF file will be replaced with the edited version. Choose "Save as new document" if you want to keep the original PDF.',
        confirmLabel: 'Replace PDF',
        cancelLabel: 'Cancel',
        danger: true,
      });
      if (!confirmed) return;
    }

    const sourceDocId = Number(activeDoc.id);
    setActiveDocSaveLoading(true);
    setActiveDocSaveError('');

    try {
      const contentHtml = activeDocDraftHtml || '';
      const res = await authFetch(`/api/documents/${activeDoc.id}/converted-file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          output_format: outputFormat,
          save_mode: saveMode,
          title: pdfConversionTitle,
          content_html: contentHtml,
          content: richHtmlToPlainText(contentHtml),
          username: username || '',
        }),
      }, { authToken });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save converted document');

      const normalized = normalizeDocument(data.document || data);
      if (saveMode === 'copy') {
        setDocuments((prev) => {
          const nextId = toPositiveDocId(normalized.id);
          const withoutExisting = prev.filter((item) => toPositiveDocId(item.id) !== nextId);
          return [normalized, ...withoutExisting];
        });
        setDocumentsTotal((prev) => Number(prev || 0) + 1);
        setDocumentsPage(1);
        setActiveDoc(normalized);
        bumpSidebarRecent(normalized);
        showToast(`Saved as "${normalized.title}".`, 'success');
      } else {
        applyUpdatedDocument(normalized);
        setSummaryHistory((prev) => prev.filter((entry) => toPositiveDocId(entry.docId) !== sourceDocId));
        showToast(`Replaced with "${normalized.title}".`, 'success');
      }

      setPdfConversionDraft(null);
      setPdfConversionChoiceOpen(false);
      setPdfConversionLoading(false);
      setPdfConversionMode('simple');
      setPdfConversionOutputFormat('docx');
      setPdfConversionSaveMode('replace');
      setPdfConversionTitle('');
      setActiveDocEditMode(false);
      setActiveDocDraftHtml(getDocumentRichHtml(normalized));
      setActiveDocFileVersion(Date.now());
    } catch (err) {
      const message = err.message || 'Failed to save converted document';
      setActiveDocSaveError(message);
      showToast(message, 'error');
    } finally {
      setActiveDocSaveLoading(false);
    }
  };

  const applyViewSnapshot = (snapshot) => {
    const safeFilters = snapshot?.filters && typeof snapshot.filters === 'object'
      ? snapshot.filters
      : DEFAULT_FILTERS;
    setSelectedDocumentIds([]);
    setDocumentsPage(1);
    setSearchDraft(String(safeFilters.query || '').trim());
    setFilters({
      query: String(safeFilters.query || '').trim(),
      start: String(safeFilters.start || '').trim(),
      end: String(safeFilters.end || '').trim(),
      tag: String(safeFilters.tag || '').trim(),
      category: String(safeFilters.category || '').trim(),
      fileType: normalizeFileTypeFilter(safeFilters.fileType),
    });
    setDocumentsSort(normalizeDocumentsSort(snapshot?.sort));
    setDocumentsPageSize(normalizeDocumentsPageSize(snapshot?.pageSize));
    setDocumentsLayout(normalizeDocumentsLayout(snapshot?.layout));
  };

  const applySearch = () => {
    setSelectedDocumentIds([]);
    setDocumentsPage(1);
    setFilters((prev) => ({ ...prev, query: searchDraft.trim() }));
  };

  useEffect(() => {
    const nextQuery = searchDraft.trim();
    const currentQuery = String(filters.query || '').trim();
    if (nextQuery === currentQuery) return;

    const timeoutId = window.setTimeout(() => {
      setSelectedDocumentIds([]);
      setDocumentsPage(1);
      setFilters((prev) => {
        const prevQuery = String(prev.query || '').trim();
        if (prevQuery === nextQuery) return prev;
        return { ...prev, query: nextQuery };
      });
    }, 280);

    return () => window.clearTimeout(timeoutId);
  }, [filters.query, searchDraft]);

  const applyQuickDateRange = (daysBack) => {
    setSelectedDocumentIds([]);
    setDocumentsPage(1);
    if (daysBack === null) {
      setFilters((prev) => ({ ...prev, start: '', end: '' }));
      return;
    }
    const range = getQuickDateRange(daysBack);
    setFilters((prev) => ({ ...prev, start: range.start, end: range.end }));
  };

  const clearSingleFilter = (filterKey) => {
    const key = String(filterKey || '').trim().toLowerCase();
    if (!key) return;
    setSelectedDocumentIds([]);
    setDocumentsPage(1);
    if (key === 'query') {
      setSearchDraft('');
    }
    setFilters((prev) => {
      if (key === 'date') {
        return { ...prev, start: '', end: '' };
      }
      if (key === 'filetype') {
        return { ...prev, fileType: '' };
      }
      if (key === 'query' || key === 'tag' || key === 'category') {
        return { ...prev, [key]: '' };
      }
      return prev;
    });
  };

  const clearFilters = () => {
    setSelectedDocumentIds([]);
    setDocumentsPage(1);
    setFilters({ ...DEFAULT_FILTERS });
    setSearchDraft('');
  };

  const resetDocumentsView = () => {
    const isDefaultView =
      !searchDraft.trim() &&
      !filters.query &&
      !filters.start &&
      !filters.end &&
      !filters.tag &&
      !filters.category &&
      !filters.fileType &&
      normalizeDocumentsSort(documentsSort) === DEFAULT_DOCUMENTS_SORT &&
      normalizeDocumentsPageSize(documentsPageSize) === DEFAULT_DOCUMENTS_PAGE_SIZE &&
      normalizeDocumentsLayout(documentsLayout) === DEFAULT_DOCUMENTS_LAYOUT &&
      documentsPage === 1 &&
      selectedDocumentIds.length === 0;

    setSelectedDocumentIds([]);
    setSearchDraft('');
    setFilters({ ...DEFAULT_FILTERS });
    setDocumentsSort(DEFAULT_DOCUMENTS_SORT);
    setDocumentsPageSize(DEFAULT_DOCUMENTS_PAGE_SIZE);
    setDocumentsLayout(DEFAULT_DOCUMENTS_LAYOUT);
    setDocumentsPage(1);
    setBulkResultSummary(DEFAULT_BULK_RESULT_SUMMARY);

    if (isDefaultView) {
      fetchDocuments(1);
    }
  };

  const activeDocFileUrl = useMemo(() => {
    if (!activeDoc) return '';
    const params = new URLSearchParams();
    if (activeDocFileVersion) params.set('v', String(activeDocFileVersion));
    if (username) params.set('username', username);
    if (authToken && !isCookieAuthToken(authToken)) params.set('auth_token', authToken);
    const qs = params.toString();
    return `/api/documents/${activeDoc.id}/file${qs ? `?${qs}` : ''}`;
  }, [activeDoc, activeDocFileVersion, authToken, username]);
  const handleDownloadDocumentFile = async (doc, { trackSidebar = false } = {}) => {
    const targetDocId = toPositiveDocId(doc?.id);
    if (!targetDocId) return;
    const isActiveDownload = !trackSidebar && Number(activeDoc?.id) === targetDocId;

    const params = new URLSearchParams();
    if (username) params.set('username', username);
    const downloadUrl = `/api/documents/${targetDocId}/file${params.toString() ? `?${params.toString()}` : ''}`;
    const fallbackFilename =
      String(doc?.filename || '').trim() ||
      [String(doc?.title || '').trim() || `document-${targetDocId}`, String(doc?.fileType || '').trim()]
        .filter(Boolean)
        .join('.');

    if (isActiveDownload) {
      setActiveDocDownloadLoading(true);
    }
    if (trackSidebar) {
      setSidebarDownloadDocId(targetDocId);
    }

    try {
      await downloadFileWithAuth(downloadUrl, {
        authToken,
        filename: fallbackFilename,
      });
    } catch (err) {
      showToast(err.message || 'Download failed.', 'error');
      throw err;
    } finally {
      if (isActiveDownload) {
        setActiveDocDownloadLoading(false);
      }
      if (trackSidebar) {
        setSidebarDownloadDocId((prev) => (prev === targetDocId ? 0 : prev));
        setSidebarMenuDocId((prev) => (prev === targetDocId ? null : prev));
      }
    }
  };
  const handleDownloadActiveDoc = async () => {
    if (!activeDoc || activeDocDownloadLoading) return;
    await handleDownloadDocumentFile(activeDoc);
  };
  const handleDownloadRecentDocument = async (doc) => {
    await handleDownloadDocumentFile(doc, { trackSidebar: true });
  };
  const activeDocStreamUrl = activeDocFileUrl;
  const activeDocExt = activeDoc ? getDocExt(activeDoc) : '';
  const activeDocIsImage = IMAGE_FILE_TYPE_VALUES.has(activeDocExt);
  const activeDocIsPdf = activeDocExt === 'pdf';
  const activeDocProcessingMeta = getDocumentProcessingMeta(activeDoc);
  const activeDocProcessingMessage = getDocumentProcessingMessage(activeDoc);
  const activeDocCanEditText = ['txt', 'docx'].includes(activeDocExt);
  const activeDocViewHtml = useMemo(() => getDocumentRichHtml(activeDoc), [activeDoc]);
  const activeDocSafeViewHtml = useMemo(() => sanitizeRichHtmlForView(activeDocViewHtml), [activeDocViewHtml]);
  const showOuterDocHeader = !activeDocIsPdf;
  const activeDocEditButtonLabel = 'Edit Content';
  const activeDocSaveButtonLabel = 'Save Content';
  const activeDocEditHint = activeDocExt === 'txt'
    ? 'TXT files can only be saved as plain text; formatting is only kept in the in-app editor view.'
    : 'Saving will overwrite the original DOCX while preserving common formatting (headings, bold, italic, lists, colors, alignment, etc.).';
  const closeDocumentPane = () => {
    setActiveDoc(null);
    setActiveDocError('');
    setActiveDocLoading(false);
    setActiveDocFileVersion(0);
    setActiveDocEditMode(false);
    setActiveDocDraftHtml('');
    setActiveDocSaveError('');
    setPdfConversionDraft(null);
    setPdfConversionChoiceOpen(false);
    setPdfConversionLoading(false);
    setPdfConversionMode('simple');
    setPdfConversionOutputFormat('docx');
    setPdfConversionSaveMode('replace');
    setPdfConversionTitle('');
    setActiveDocDownloadLoading(false);
    clearActiveDocShareState();
  };

  const openFilesAndFocusSearch = () => {
    if (docPaneVisible) closeDocumentPane();
    setShowFiles(true);
    window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select?.();
    }, 0);
  };

  const buildSuggestedSavedViewName = () => {
    if (filters.query) return `Search: ${filters.query.slice(0, 32)}`;
    if (filters.fileType) return `${getFileTypeFilterLabel(filters.fileType)} Notes`;
    if (filters.category) return `${filters.category} Notes`;
    if (filters.tag) return `Tag: ${filters.tag}`;
    if (filters.start || filters.end) return 'Date Range View';
    return 'My View';
  };

  const handleSaveCurrentView = async () => {
    if (!showFiles) {
      setShowFiles(true);
    }
    const input = await requestTextInput({
      title: 'Save Current View',
      description: `Save current filters/sort/page size (up to ${MAX_SAVED_VIEWS_PER_WORKSPACE} views per workspace).`,
      placeholder: 'e.g. Midterm Revision',
      initialValue: buildSuggestedSavedViewName(),
      confirmLabel: 'Save View',
      cancelLabel: 'Cancel',
      required: true,
      trimResult: true,
    });
    if (input === null) return;
    const name = String(input || '').trim().slice(0, 48);
    if (!name) return;

    const nowIso = new Date().toISOString();
    const existing = savedViews.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      const shouldReplace = await requestConfirmation({
        title: 'Update Existing View?',
        description: `"${existing.name}" already exists. Replace it with current filters?`,
        confirmLabel: 'Replace',
        cancelLabel: 'Cancel',
      });
      if (!shouldReplace) return;
      setSavedViews((prev) =>
        prev.map((item) => (
          item.id === existing.id
            ? {
                ...item,
                name,
                filters: { ...currentViewSnapshot.filters },
                sort: currentViewSnapshot.sort,
                pageSize: currentViewSnapshot.pageSize,
                layout: currentViewSnapshot.layout,
                updatedAt: nowIso,
              }
            : item
        ))
      );
      setActiveSavedViewId(existing.id);
      showToast(`Saved view "${name}" updated.`, 'success');
      return;
    }

    if (savedViews.length >= MAX_SAVED_VIEWS_PER_WORKSPACE) {
      showToast(
        `You can keep up to ${MAX_SAVED_VIEWS_PER_WORKSPACE} saved views per workspace. Remove one first.`,
        'warning'
      );
      return;
    }

    const nextView = {
      id: createSavedViewId(),
      name,
      filters: { ...currentViewSnapshot.filters },
      sort: currentViewSnapshot.sort,
      pageSize: currentViewSnapshot.pageSize,
      layout: currentViewSnapshot.layout,
      pinned: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    setSavedViews((prev) => [nextView, ...prev].slice(0, MAX_SAVED_VIEWS_PER_WORKSPACE));
    setActiveSavedViewId(nextView.id);
    showToast(`Saved view "${name}" created.`, 'success');
  };

  const handleApplySavedView = (view) => {
    if (!view) return;
    applyViewSnapshot(view);
    setActiveSavedViewId(view.id);
    showToast(`Applied "${view.name}".`, 'info');
  };

  const handleRenameSavedView = async (view) => {
    if (!view) return;
    const input = await requestTextInput({
      title: 'Rename Saved View',
      description: 'Saved views stay private to this account and workspace.',
      placeholder: 'View name',
      initialValue: view.name,
      confirmLabel: 'Rename',
      cancelLabel: 'Cancel',
      required: true,
      trimResult: true,
    });
    if (input === null) return;
    const nextName = String(input || '').trim().slice(0, 48);
    if (!nextName || nextName === view.name) return;
    setSavedViews((prev) =>
      prev.map((item) =>
        item.id === view.id
          ? {
              ...item,
              name: nextName,
              updatedAt: new Date().toISOString(),
            }
          : item
      )
    );
    showToast('Saved view renamed.', 'success');
  };

  const handleDeleteSavedView = async (view) => {
    if (!view) return;
    const confirmed = await requestConfirmation({
      title: 'Delete Saved View?',
      description: `This only removes "${view.name}" from this workspace.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!confirmed) return;
    setSavedViews((prev) => prev.filter((item) => item.id !== view.id));
    if (activeSavedViewId === view.id) setActiveSavedViewId('');
    showToast('Saved view deleted.', 'success');
  };

  const handleTogglePinSavedView = (view) => {
    if (!view) return;
    const wasPinned = Boolean(view.pinned);
    const nowIso = new Date().toISOString();
    setSavedViews((prev) => {
      const index = prev.findIndex((item) => item.id === view.id);
      if (index < 0) return prev;
      const current = prev[index];
      const rest = prev.filter((item) => item.id !== view.id);
      if (!current.pinned) {
        return [{ ...current, pinned: true, updatedAt: nowIso }, ...rest];
      }
      let insertAt = 0;
      for (let i = 0; i < rest.length; i += 1) {
        if (rest[i].pinned) insertAt = i + 1;
      }
      const updated = { ...current, pinned: false, updatedAt: nowIso };
      return [...rest.slice(0, insertAt), updated, ...rest.slice(insertAt)];
    });
    showToast(wasPinned ? 'Unpinned view.' : 'Pinned view to top.', 'success');
  };

  const handleMoveSavedView = (view, offset) => {
    if (!view) return;
    const step = Number(offset);
    if (!Number.isFinite(step) || step === 0) return;
    setSavedViews((prev) => {
      const index = prev.findIndex((item) => item.id === view.id);
      if (index < 0) return prev;
      const nextIndex = index + (step > 0 ? 1 : -1);
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = prev.slice();
      const temp = next[index];
      next[index] = next[nextIndex];
      next[nextIndex] = temp;
      return next;
    });
  };

  const handleExportSavedViews = () => {
    if (!savedViews.length) {
      showToast('No saved views to export.', 'warning');
      return;
    }
    const exportPayload = {
      exportedAt: new Date().toISOString(),
      account: accountName,
      workspaceId: activeWorkspaceId || '',
      workspaceName: activeWorkspace?.name || '',
      views: savedViews.map((item) => ({
        id: item.id,
        name: item.name,
        pinned: Boolean(item.pinned),
        filters: item.filters,
        sort: item.sort,
        pageSize: item.pageSize,
        layout: item.layout,
        createdAt: item.createdAt || '',
        updatedAt: item.updatedAt || '',
      })),
    };
    try {
      const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const safeWorkspace = String(activeWorkspace?.name || 'workspace')
        .replace(/[^\w-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
      link.download = `saved-views-${safeWorkspace || 'workspace'}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      showToast('Saved views exported.', 'success');
    } catch {
      showToast('Failed to export saved views.', 'error');
    }
  };

  const handleOpenSavedViewsImport = () => {
    setSavedViewsMenuOpen(false);
    savedViewsImportInputRef.current?.click();
  };

  const handleImportSavedViewsFromFile = async (event) => {
    const file = event.target?.files?.[0] || null;
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const incoming = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.views)
          ? parsed.views
          : [];
      const normalizedIncoming = incoming
        .map((item) => normalizeSavedView(item))
        .filter(Boolean);
      if (!normalizedIncoming.length) {
        showToast('No valid saved views found in this file.', 'warning');
        return;
      }

      setSavedViews((prev) => {
        const seenNames = new Set();
        const usedIds = new Set();
        const merged = [];
        [...normalizedIncoming, ...prev].forEach((item) => {
          const key = item.name.toLowerCase();
          if (seenNames.has(key)) return;
          seenNames.add(key);
          let nextId = String(item.id || '').trim() || createSavedViewId();
          while (usedIds.has(nextId)) nextId = createSavedViewId();
          usedIds.add(nextId);
          merged.push({
            ...item,
            id: nextId,
            createdAt: item.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        });
        return merged.slice(0, MAX_SAVED_VIEWS_PER_WORKSPACE);
      });
      showToast(`Imported ${normalizedIncoming.length} saved view(s).`, 'success');
    } catch {
      showToast('Import failed. Please check JSON format.', 'error');
    }
  };

  const activeDocShareModeLabel = getLinkSharingModeLabel(activeWorkspaceSettings.link_sharing_mode);
  const activeDocShareDisabledReason = getShareDisabledReasonForDoc(activeDoc);
  const activeDocShareHint = activeDocShareDisabledReason || 'Send this note by email.';
  const workspaceShareManagementDisabledReason = !username
    ? 'Please sign in to manage share links.'
    : !workspaceReady
      ? 'Workspace is still loading.'
    : !activeWorkspaceId
      ? 'Open a workspace before managing share links.'
      : !canCurrentUserManageShareLinks
        ? 'Only workspace owner can manage share links in current settings.'
        : '';
  const canShowWorkspaceShareManagement = Boolean(username && workspaceReady && activeWorkspaceId);
  const canOpenWorkspaceShareManagement = Boolean(
    canShowWorkspaceShareManagement && !workspaceShareManagementDisabledReason
  );
  const summaryResultRebuildDocId = toPositiveDocId(summaryResultHistoryEntry?.docId);
  const summaryResultRebuildId = String(summaryResultHistoryEntry?.id || '').trim();
  const summaryResultRebuildLoading = Boolean(
    summaryCenterActionId &&
      (summaryCenterActionId === summaryResultRebuildId ||
        summaryCenterActionId === `doc-${summaryResultRebuildDocId}`)
  );
  const activeDocShareEmailExpiryLabel = activeDocShareEmailResult?.expires_at
    ? formatDateTimeLabel(activeDocShareEmailResult.expires_at)
    : '';
  const activeDocShareLinksManagerContent = canOpenWorkspaceShareManagement ? (
    <section className="document-detail-share-links-panel notion-home-share-links-panel" aria-label="Share links management">
      <div className="notion-doc-share-manager-head">
        <div>
          <h3>Manage Links</h3>
          <p className="muted tiny">All share links in this workspace are listed together here.</p>
        </div>
        <div className="notion-doc-share-actions">
          <button
            type="button"
            className="btn btn-delete"
            onClick={handleRevokeAllActiveDocShareLinks}
            disabled={
              activeDocShareLinksLoading ||
              activeDocShareActionLoadingId !== 0 ||
              !activeDocShareLinks.length
            }
          >
            {activeDocShareActionLoadingId === -1 ? 'Revoking...' : 'Revoke All'}
          </button>
          <button
            type="button"
            className="btn btn-delete"
            onClick={handleDeleteInactiveActiveDocShareLinks}
            disabled={
              activeDocShareLinksLoading ||
              activeDocShareActionLoadingId !== 0 ||
              !activeDocShareLinks.some((item) => !isActiveShareLink(item))
            }
          >
            {activeDocShareActionLoadingId === -2 ? 'Deleting Inactive...' : 'Delete Inactive'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => refreshActiveDocShareLinks()}
            disabled={activeDocShareLinksLoading || activeDocShareActionLoadingId !== 0}
          >
            Refresh
          </button>
        </div>
      </div>
      {activeDocShareLinksError && (
        <p className="muted tiny">Load failed: {activeDocShareLinksError}</p>
      )}
      {activeDocShareLinksLoading && !activeDocShareLinksError && (
        <p className="muted tiny">Loading share links...</p>
      )}
      {!activeDocShareLinksLoading && !activeDocShareLinksError && !activeDocShareLinks.length && (
        <p className="muted tiny">No share links yet. Open a note and send it by email to create one.</p>
      )}
      {activeDocShareLinks.length > 0 && (
        <ul className="notion-doc-share-list">
          {activeDocShareLinks.map((item, index) => {
            const status = String(item?.status || 'unknown').toLowerCase();
            const isActive = isActiveShareLink(item);
            const loading = Number(item?.id) === activeDocShareActionLoadingId;
            const documentLabel = String(
              item?.document_title ||
                item?.documentTitle ||
                item?.document_filename ||
                item?.documentFilename ||
                ''
            ).trim();
            const recipientLabel = String(item?.recipient_email || item?.recipientEmail || '').trim();
            return (
              <li key={`doc-share-${item?.id || item?.token || index}`}>
                {documentLabel && <strong className="notion-doc-share-document">{documentLabel}</strong>}
                <a href={item?.share_url || '#'} target="_blank" rel="noreferrer">
                  {item?.share_url || 'Invalid link'}
                </a>
                <span className="notion-doc-share-meta">
                  {recipientLabel ? `Sent to: ${recipientLabel} · ` : ''}
                  Status: {item?.is_expired ? 'expired' : status} · Expires: {formatDateTimeLabel(item?.expires_at)}
                </span>
                <div className="notion-doc-share-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => handleCopyExistingShareLink(item?.share_url)}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    className="btn btn-delete"
                    onClick={() =>
                      isActive
                        ? handleRevokeActiveDocShareLink(item)
                        : handleDeleteActiveDocShareLink(item)
                    }
                    disabled={loading || activeDocShareActionLoadingId < 0}
                  >
                    {loading
                      ? (activeDocShareActionLoadingType === 'delete' ? 'Deleting...' : 'Revoking...')
                      : (isActive ? 'Revoke' : 'Delete')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  ) : null;

  return (
    <div
      className={[
        'notion-shell',
        sidebarDensityClass,
        sidebarCollapsed ? 'is-sidebar-collapsed' : '',
        mobileSidebarOpen ? 'is-mobile-sidebar-open' : '',
      ].filter(Boolean).join(' ')}
      style={workspaceThemeStyle}
    >
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      {mobileSidebarOpen && (
        <button
          type="button"
          className="notion-mobile-sidebar-backdrop"
          aria-label="Close navigation overlay"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      <WorkspaceSidebar
        mobileSidebarOpen={mobileSidebarOpen}
        onCloseMobileSidebar={() => setMobileSidebarOpen(false)}
        workspaceMenuOpen={workspaceMenuOpen}
        workspaceMenuRef={workspaceMenuRef}
        onToggleWorkspaceMenu={() => setWorkspaceMenuOpen((prev) => !prev)}
        activeWorkspace={activeWorkspace}
        accountName={accountName}
        getWorkspaceIconLabel={workspaceIconLabel}
        isLoggedIn={isLoggedIn}
        workspaceMemberCount={workspaceMemberCount}
        pendingRequestCount={pendingRequestCount}
        onOpenWorkspaceSettings={() => {
          setMobileSidebarOpen(false);
          openWorkspaceSettingsPanel();
        }}
        canOpenWorkspaceSettings={
          Boolean(activeWorkspace) &&
          activeWorkspace?.is_owner !== false &&
          !workspaceLoading &&
          !workspaceActionLoading
        }
        onOpenWorkspaceInvite={() => {
          setMobileSidebarOpen(false);
          openWorkspaceInvitePanel();
        }}
        canOpenWorkspaceInvite={
          Boolean(activeWorkspace) &&
          !workspaceLoading &&
          !workspaceActionLoading
        }
        accountEmail={accountEmail}
        onOpenWorkspaceManager={() => {
          setMobileSidebarOpen(false);
          setWorkspaceManagerOpen(true);
          setAccountManagerOpen(false);
          setWorkspaceSettingsOpen(false);
          setWorkspaceInviteOpen(false);
          setWorkspaceMenuOpen(false);
        }}
        onOpenAccountManager={() => {
          setMobileSidebarOpen(false);
          setAccountManagerOpen(true);
          setWorkspaceManagerOpen(false);
          setWorkspaceSettingsOpen(false);
          setWorkspaceInviteOpen(false);
          setWorkspaceMenuOpen(false);
        }}
        workspaces={workspaceState.workspaces || []}
        activeWorkspaceId={workspaceState.activeWorkspaceId}
        onSelectWorkspace={(workspaceId) => {
          setMobileSidebarOpen(false);
          handleSelectWorkspace(workspaceId);
        }}
        onCreateWorkspace={() => {
          setMobileSidebarOpen(false);
          handleCreateWorkspace();
        }}
        workspaceBusy={workspaceLoading || workspaceActionLoading}
        onAuthAction={() => {
          setMobileSidebarOpen(false);
          if (isLoggedIn) handleSignOut();
          else navigate('/login');
        }}
        homeActive={!showFiles && !docPaneVisible}
        filesActive={showFiles && !docPaneVisible}
        onGoHome={() => {
          setMobileSidebarOpen(false);
          closeDocumentPane();
          setShowFiles(false);
        }}
        onGoFiles={() => {
          setMobileSidebarOpen(false);
          closeDocumentPane();
          setShowFiles(true);
        }}
        showStarredSection={activeWorkspaceSettings.show_starred_section}
        starredDocs={sidebarStarredDocs}
        activeDocId={activeDoc?.id}
        starredDragId={starredDragId}
        onStarredDragStart={handleStarredDragStart}
        onStarredDrop={handleStarredDrop}
        onStarredDragEnd={handleStarredDragEnd}
        onOpenStarredNote={(doc) => {
          setMobileSidebarOpen(false);
          handleOpenStarredNote(doc);
        }}
        onToggleStarredNote={handleToggleStarredNote}
        showRecentSection={activeWorkspaceSettings.show_recent_section}
        recentMenuRef={recentMenuRef}
        recentDocs={sidebarDocs}
        onOpenRecentDocument={(doc) => {
          setMobileSidebarOpen(false);
          openDocumentInPane(doc.id, { fromSidebar: true, seedDoc: doc });
        }}
        onCollapseSidebar={() => {
          setWorkspaceMenuOpen(false);
          setSidebarMenuDocId(null);
          setSidebarCollapsed(true);
        }}
      />

      <div className="notion-main">
        <header className="notion-topbar" role="banner">
          <div className="notion-top-left">
            {sidebarCollapsed && (
              <button
                type="button"
                className="notion-sidebar-expand-btn"
                onClick={() => setSidebarCollapsed(false)}
                aria-label="Show sidebar"
                title="Show sidebar"
              >
                <span aria-hidden="true">☰</span>
                <span>Sidebar</span>
              </button>
            )}
            <button
              type="button"
              className="notion-mobile-nav-btn"
              onClick={() => setMobileSidebarOpen(true)}
              aria-label="Open navigation"
            >
              ☰
            </button>
            <div className="notion-top-title-group">
              <strong>{activeWorkspace?.name || `${accountName}'s Workspace`}</strong>
              <span className="notion-top-muted">{isLoggedIn ? 'Private workspace' : 'Guest mode'}</span>
            </div>
            <span className="notion-top-time">{nowLabel}</span>
          </div>
          <div className="notion-top-actions">
            <FriendsMessagesWidget
              enabled={isLoggedIn}
              authToken={authToken}
              username={username}
              activeWorkspaceId={activeWorkspaceId}
              activeWorkspaceName={activeWorkspace?.name || ''}
              workspaces={workspaceState.workspaces || []}
              variant="topbar"
              onOpenNotification={handleOpenWebsiteNotification}
              onFileShareAccepted={handleFriendFileShareAccepted}
              openRequestKey={messagesOpenRequest.key}
              openRequestTab={messagesOpenRequest.tab}
            />
            <FeedbackWidget
              enabled={isLoggedIn}
              workspaceId={activeWorkspaceId}
              documentId={activeDoc?.id || ''}
              variant="topbar"
            />
            {canShowWorkspaceShareManagement && (
              <button
                type="button"
                className="btn notion-top-summary-btn notion-top-manage-links-btn"
                onClick={openActiveDocShareManagerInModal}
                disabled={Boolean(workspaceShareManagementDisabledReason)}
                title={workspaceShareManagementDisabledReason || 'Review, copy, revoke, or delete existing share links'}
              >
                Manage Links
              </button>
            )}
            <button
              type="button"
              className="btn notion-top-summary-btn"
              onClick={handleOpenSummaryCenter}
              disabled={!activeWorkspaceSettings.allow_ai_tools}
              title={
                activeWorkspaceSettings.allow_ai_tools
                  ? 'Open document summary history'
                  : 'AI is disabled in workspace settings'
              }
            >
              Summaries ({summaryHistory.length})
            </button>
          </div>
        </header>

        <main id="main" className="notion-content" role="main">
          {!isLoggedIn && (
            <button
              id="login-warning"
              type="button"
              className="notion-warning notion-login-warning-link"
              onClick={() => navigate('/login')}
            >
              <span>You are not signed in yet. Uploading, viewing, summarizing, deleting, and tag editing require </span>
              <span className="notion-login-warning-signin">sign-in</span>
              <span>.</span>
            </button>
          )}

          {summaryProgress.active && (
            <section className="notion-summary-progress" aria-live="polite">
              <div className="notion-summary-progress-head">
                <strong>{summaryProgressLabel}</strong>
                {summaryProgress.docTitle && (
                  <span className="muted tiny">Document: {summaryProgress.docTitle}</span>
                )}
              </div>
              {summaryProgress.forceRefresh && summaryProgress.docId > 0 && (
                <div className="notion-summary-progress-steps" role="status">
                  <span className={summaryProgress.phase === 'refreshing' ? 'is-active' : 'is-done'}>
                    1. Refresh full PDF text
                  </span>
                  <span className={summaryProgress.phase === 'summarizing' ? 'is-active' : ''}>
                    2. Chunk and summarize
                  </span>
                </div>
              )}
            </section>
          )}

          {(activeDocLoading || activeDocError || activeDoc) && (
            <section className="notion-inline-doc" aria-live="polite">
              {activeDocLoading && <p className="muted">Loading document content...</p>}

              {!activeDocLoading && activeDocError && (
                <p className="muted">Load failed: {activeDocError}</p>
              )}

              {!activeDocLoading && activeDoc && (
                <article
                  className={`document-detail-card notion-inline-doc-card${
                    activeDocIsPdf ? ' notion-inline-doc-card-pdf' : ''
                  }`}
                >
                  {showOuterDocHeader && (
                    <header className="notion-inline-doc-head">
                      <div className="notion-inline-doc-summary">
                        <h2>{activeDoc.title}</h2>
                        <div className="notion-inline-doc-meta-grid" aria-label="Document details">
                          <span className="notion-inline-doc-meta-item">
                            <span>Uploaded</span>
                            <strong>{activeDoc.uploadedAt ? new Date(activeDoc.uploadedAt).toLocaleString() : 'Unknown'}</strong>
                          </span>
                          <span className="notion-inline-doc-meta-item">
                            <span>Category</span>
                            <strong>{normalizeCategory(activeDoc.category)}</strong>
                          </span>
                          <span className="notion-inline-doc-meta-item">
                            <span>Tags</span>
                            <strong>{activeDoc.tags?.length ? activeDoc.tags.join(', ') : 'None'}</strong>
                          </span>
                        </div>
                        {activeDocProcessingMeta && (
                          <div className={`document-processing-message is-${activeDoc.processingStatus}`} role="status">
                            {activeDocProcessingMessage}
                          </div>
                        )}
                      </div>
                      <div className="notion-inline-doc-actions">
                        <button
                          type="button"
                          className="btn"
                          onClick={handleDownloadActiveDoc}
                          disabled={activeDocDownloadLoading}
                        >
                          {activeDocDownloadLoading ? 'Downloading...' : 'Download File'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => handleUseDocumentForAI(activeDoc)}
                          disabled={!activeWorkspaceSettings.allow_ai_tools || Boolean(activeDocProcessingMeta)}
                          title={activeDocProcessingMeta ? activeDocProcessingMeta.summarizeTitle : undefined}
                        >
                            Summarize Note
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => handleRegenerateDocumentSummary(activeDoc)}
                          disabled={!activeWorkspaceSettings.allow_ai_tools || Boolean(activeDocProcessingMeta)}
                          title={
                            activeDocProcessingMeta
                              ? activeDocProcessingMeta.summarizeTitle
                              : activeWorkspaceSettings.allow_ai_tools
                              ? 'Bypass cache and refresh document text before summarizing'
                              : 'AI is disabled in workspace settings'
                          }
                        >
                          Rebuild (Refresh Text)
                        </button>
                        {activeDocIsImage && (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => handleRunDocumentImageOcr(activeDoc)}
                            disabled={!activeWorkspaceSettings.allow_ai_tools || !activeWorkspaceSettings.allow_ocr || isExtracting}
                          >
                            {isExtracting ? 'Scanning...' : 'Scan Image'}
                          </button>
                        )}
                        <button
                          type="button"
                          className={`btn notion-inline-star-btn${activeDocIsStarred ? ' active' : ''}`}
                          onClick={() => handleToggleStarredNote(activeDoc)}
                        >
                          {activeDocIsStarred ? '★ Starred' : '☆ Star'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={openActiveDocShareSendModal}
                          disabled={Boolean(activeDocShareDisabledReason)}
                          title={activeDocShareHint}
                        >
                          Send
                        </button>
                        <button
                          type="button"
                          className="edit-tags"
                          onClick={() => handleRenameDocument(activeDoc)}
                          disabled={
                            !isLoggedIn ||
                            activeDocSaveLoading ||
                            !activeWorkspaceSettings.allow_note_editing
                          }
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="edit-tags"
                          onClick={() => handleEditCategory(activeDoc)}
                          disabled={
                            !isLoggedIn ||
                            activeDocSaveLoading ||
                            !activeWorkspaceSettings.allow_note_editing
                          }
                        >
                          Edit Category
                        </button>
                        {activeDocCanEditText && (
                          <button
                            type="button"
                            className="edit-tags"
                            onClick={() => {
                              setActiveDocEditMode((prev) => !prev);
                              setActiveDocSaveError('');
                              setActiveDocDraftHtml(getDocumentRichHtml(activeDoc));
                            }}
                            disabled={activeDocSaveLoading || !activeWorkspaceSettings.allow_note_editing}
                          >
                            {activeDocEditMode ? 'Cancel Edit' : activeDocEditButtonLabel}
                          </button>
                        )}
                        {activeDocCanEditText && activeDocEditMode && (
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={handleSaveActiveDocContent}
                            disabled={activeDocSaveLoading || !activeWorkspaceSettings.allow_note_editing}
                          >
                            {activeDocSaveLoading ? 'Saving...' : activeDocSaveButtonLabel}
                          </button>
                        )}
                      </div>
                    </header>
                  )}

                  {!showOuterDocHeader && (
                    <section className="notion-inline-share-strip" aria-label="Share this note">
                      <div>
                        <strong>Share this note</strong>
                        <p className="muted tiny">
                          Send by email first. Convert a PDF when you need an editable copy.
                        </p>
                      </div>
                      <div className="notion-doc-share-actions">
                        <button
                          type="button"
                          className="btn"
                          onClick={openActiveDocShareSendModal}
                          disabled={Boolean(activeDocShareDisabledReason)}
                          title={activeDocShareHint}
                        >
                          Send
                        </button>
                        {activeDocIsPdf && (
                          <button
                            type="button"
                            className="btn"
                            onClick={handleOpenPdfConversionChoices}
                            disabled={
                              pdfConversionLoading ||
                              activeDocSaveLoading ||
                              !isLoggedIn ||
                              !activeWorkspaceSettings.allow_note_editing
                            }
                            aria-expanded={pdfConversionChoiceOpen}
                            title="Choose how to convert this PDF before editing"
                          >
                            {pdfConversionLoading ? 'Converting...' : 'Edit as Word'}
                          </button>
                        )}
                      </div>
                    </section>
                  )}
                  {activeDocIsPdf && pdfConversionChoiceOpen && !pdfConversionDraft && (
                    <section className="notion-pdf-conversion-choice" aria-label="Choose PDF conversion type">
                      <div className="notion-pdf-conversion-choice-head">
                        <strong>Choose how to make this PDF editable</strong>
                        <p>
                          Start with a clean text draft for most edits, or try layout mode when the page structure matters.
                        </p>
                      </div>
                      <div className="notion-pdf-conversion-choice-grid">
                        <button
                          type="button"
                          className="notion-pdf-conversion-choice-card recommended"
                          onClick={() => handleStartPdfConversion('simple')}
                          disabled={pdfConversionLoading || activeDocSaveLoading}
                        >
                          <span>Clean text draft</span>
                          <strong>Best for editing and saving as Word</strong>
                          <small>Extracts readable text into a simple editor. Use this for notes, summaries, and quick rewrites.</small>
                        </button>
                        <button
                          type="button"
                          className="notion-pdf-conversion-choice-card"
                          onClick={() => handleStartPdfConversion('layout')}
                          disabled={pdfConversionLoading || activeDocSaveLoading}
                        >
                          <span>Try to keep layout</span>
                          <strong>Best when spacing and page order matter</strong>
                          <small>Attempts to keep page order, font sizes, indentation, and image placeholders. Review before saving.</small>
                        </button>
                      </div>
                      <div className="notion-pdf-conversion-choice-actions">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setPdfConversionChoiceOpen(false)}
                          disabled={pdfConversionLoading || activeDocSaveLoading}
                        >
                          Cancel
                        </button>
                      </div>
                    </section>
                  )}
                  {username && !canCurrentUserManageShareLinks && (
                    <p className="muted tiny">
                      Share link management is owner-only in current workspace settings.
                    </p>
                  )}

                  <section
                    className={`document-body notion-inline-doc-body${activeDocIsPdf ? ' notion-inline-doc-body-pdf' : ''}`}
                  >
                    {pdfConversionDraft ? (
                      <div className="notion-doc-editor notion-pdf-conversion-editor">
                        <div className="notion-pdf-conversion-head">
                          <div>
                            <strong>Editable PDF draft</strong>
                            <p className="muted tiny">
                              Review and edit the converted content, then save it as Word or PDF.
                            </p>
                          </div>
                          <span className="notion-chip">
                            {pdfConversionDraft.mode === 'layout' ? 'Layout draft' : 'Simple draft'}
                          </span>
                        </div>
                        <Suspense fallback={<p className="muted">Loading editor...</p>}>
                          <RichTextEditor
                            value={activeDocDraftHtml}
                            onChange={setActiveDocDraftHtml}
                            disabled={activeDocSaveLoading}
                            placeholder="Edit converted PDF content here..."
                            requestTextInput={requestTextInput}
                          />
                        </Suspense>
                        {Array.isArray(pdfConversionDraft.warnings) && pdfConversionDraft.warnings.length > 0 && (
                          <div className="notion-pdf-conversion-warning" role="note">
                            {pdfConversionDraft.warnings.slice(0, 3).map((warning) => (
                              <p key={warning}>{warning}</p>
                            ))}
                          </div>
                        )}
                        <div className="notion-pdf-conversion-controls">
                          <label className="notion-pdf-conversion-field">
                            <span>Save as</span>
                            <select
                              value={pdfConversionOutputFormat}
                              onChange={(event) => handleChangePdfConversionOutputFormat(event.target.value)}
                              disabled={activeDocSaveLoading}
                            >
                              <option value="docx">Word document (.docx)</option>
                              <option value="pdf">PDF (.pdf)</option>
                            </select>
                          </label>
                          <label className="notion-pdf-conversion-field">
                            <span>Save mode</span>
                            <select
                              value={pdfConversionSaveMode}
                              onChange={(event) => setPdfConversionSaveMode(event.target.value === 'copy' ? 'copy' : 'replace')}
                              disabled={activeDocSaveLoading}
                            >
                              <option value="replace">Replace original file</option>
                              <option value="copy">Save as new document</option>
                            </select>
                          </label>
                          <label className="notion-pdf-conversion-field notion-pdf-conversion-field-wide">
                            <span>File name</span>
                            <input
                              type="text"
                              value={pdfConversionTitle}
                              onChange={(event) => setPdfConversionTitle(event.target.value)}
                              disabled={activeDocSaveLoading}
                              placeholder={`Edited document.${pdfConversionOutputFormat}`}
                            />
                          </label>
                        </div>
                        <div className="notion-pdf-conversion-actions">
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={handleSavePdfConversionDraft}
                            disabled={activeDocSaveLoading || !activeWorkspaceSettings.allow_note_editing}
                          >
                            {activeDocSaveLoading ? 'Saving...' : 'Save Converted File'}
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={handleDiscardPdfConversionDraft}
                            disabled={activeDocSaveLoading}
                          >
                            Discard Draft
                          </button>
                        </div>
                        {activeDocSaveError && (
                          <p className="notion-doc-editor-error" role="alert">
                            Save failed: {activeDocSaveError}
                          </p>
                        )}
                      </div>
                    ) : activeDocCanEditText && activeDocEditMode ? (
                      <div className="notion-doc-editor">
                        <Suspense fallback={<p className="muted">Loading editor...</p>}>
                          <RichTextEditor
                            value={activeDocDraftHtml}
                            onChange={setActiveDocDraftHtml}
                            disabled={activeDocSaveLoading}
                            placeholder="Edit document content here..."
                            requestTextInput={requestTextInput}
                          />
                        </Suspense>
                        <p className="muted tiny">
                          {activeDocEditHint}
                        </p>
                        {activeDocSaveError && (
                          <p className="notion-doc-editor-error" role="alert">
                            Save failed: {activeDocSaveError}
                          </p>
                        )}
                      </div>
                    ) : activeDocCanEditText ? (
                      <div
                        className="notion-doc-rich-view"
                        dangerouslySetInnerHTML={{ __html: activeDocSafeViewHtml }}
                      />
                    ) : activeDocIsImage ? (
                      <img src={activeDocFileUrl} alt={activeDoc.title} />
                    ) : activeDocIsPdf ? (
                      <Suspense fallback={<p className="muted">Loading PDF preview...</p>}>
                        <PdfInlineViewer
                          src={activeDocStreamUrl}
                          title={activeDoc.title}
                          uploadedAt={activeDoc.uploadedAt}
                          tags={activeDoc.tags}
                          onDownload={handleDownloadActiveDoc}
                          downloadLoading={activeDocDownloadLoading}
                          editable={activeWorkspaceSettings.allow_note_editing}
                          onSummarizeDocument={() => handleUseDocumentForAI(activeDoc)}
                          canSummarize={isLoggedIn && activeWorkspaceSettings.allow_ai_tools}
                          isSummarizing={isAnalyzing}
                          summarizeDisabledHint={
                            isLoggedIn ? 'AI is disabled in workspace settings' : 'Please sign in'
                          }
                          saveLoading={activeDocSaveLoading}
                          saveError={activeDocSaveError}
                          onClearSaveError={() => setActiveDocSaveError('')}
                          onSaveEditedPdf={handleSaveActivePdfFile}
                          requestConfirmation={requestConfirmation}
                          requestTextInput={requestTextInput}
                        />
                      </Suspense>
                    ) : (
                      <pre>{activeDoc.content || 'No text content extracted.'}</pre>
                    )}
                  </section>
                </article>
              )}
            </section>
          )}

          {!showFiles && !docPaneVisible && (
            <section className="notion-overview-hero" aria-label="Workspace overview">
              <div className="notion-overview-hero-main">
                <div className="notion-overview-eyebrow">
                  <WorkspaceIcon
                    value={workspaceIconLabel(activeWorkspace, accountName)}
                    fallback={accountName}
                    large
                  />
                  <span>{isLoggedIn ? 'Workspace overview' : 'Guest workspace'}</span>
                </div>
                <h2>{activeWorkspace?.name || `${accountName}'s Workspace`}</h2>
                <p>
                  {activeWorkspaceSettings.description ||
                    'Keep lecture files, summaries, and collaboration rules in one workspace that feels closer to modern study tools.'}
                </p>
              </div>
            </section>
          )}

          {!showFiles && !docPaneVisible && (
            <section className="notion-dashboard-grid" aria-label="Dashboard summary">
              <article className="notion-dashboard-card">
                <h3>Total Notes</h3>
                <strong>{dashboardStats.total}</strong>
                <span>All saved notes</span>
              </article>
              <article className="notion-dashboard-card">
                <h3>Categories</h3>
                <strong>{dashboardStats.categories}</strong>
                <span>Organized subject buckets</span>
              </article>
              <article className="notion-dashboard-card">
                <h3>Tags</h3>
                <strong>{dashboardStats.tags}</strong>
                <span>Filter-friendly labels</span>
              </article>
              <article className="notion-dashboard-card">
                <h3>Uploaded in 7 Days</h3>
                <strong>{dashboardStats.recentUploads}</strong>
                <span>Recent revision activity</span>
              </article>
            </section>
          )}

          {!showFiles && !docPaneVisible && activeWorkspaceSettings.show_usage_chart && (
            <>
              <Suspense fallback={<p className="muted tiny">Loading usage chart...</p>}>
                <UsageChart usageMap={usageMap} />
              </Suspense>
            </>
          )}

          {showFiles && !docPaneVisible && (
            <section id="files-section" className="files-section notion-files-section">
              <div className="notion-files-layout">
                <section className="notion-files-workbench notion-panel-block" aria-labelledby="files-workbench-title">
                  <div className="notion-files-workbench-head">
                    <div className="notion-files-workbench-copy">
                      <h2 id="files-workbench-title" className="section-title">Notes</h2>
                    </div>
                    <div className="notion-files-actionbar">
                      <div className="notion-files-toolbar-actions">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={openUploadPicker}
                          disabled={!activeWorkspaceSettings.allow_uploads || uploadQueueRunning}
                        >
                          {uploadQueueRunning ? 'Uploading...' : 'Upload'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => openImageOcrPicker()}
                          disabled={
                            !isLoggedIn ||
                            isExtracting ||
                            bulkActionLoading ||
                            selectAllMatchedLoading ||
                            !activeWorkspaceSettings.allow_ai_tools ||
                            !activeWorkspaceSettings.allow_ocr
                          }
                          title={
                            !isLoggedIn
                              ? 'Please sign in'
                              : !activeWorkspaceSettings.allow_ai_tools
                                ? 'AI is disabled in workspace settings'
                                : !activeWorkspaceSettings.allow_ocr
                                  ? 'OCR is disabled in workspace settings'
                                  : undefined
                          }
                        >
                          {isExtracting ? 'Scanning...' : 'Scan Image'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={handleOpenSummaryCenter}
                          disabled={!activeWorkspaceSettings.allow_ai_tools}
                          title={
                            activeWorkspaceSettings.allow_ai_tools
                              ? 'Open document summary history'
                              : 'AI is disabled in workspace settings'
                          }
                        >
                          Summaries
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={handleOpenTrashModal}
                          disabled={!isLoggedIn || bulkActionLoading || selectAllMatchedLoading}
                        >
                          Trash{trashTotal > 0 ? ` (${trashTotal})` : ''}
                        </button>
                      </div>
                    </div>
                  </div>

                  <input
                    ref={savedViewsImportInputRef}
                    type="file"
                    accept=".json,application/json"
                    className="sr-only"
                    onChange={handleImportSavedViewsFromFile}
                  />

                  {!uploadTrayCollapsed && (
                    <UploadPanel
                      embedded
                      allowUploads={activeWorkspaceSettings.allow_uploads}
                      dragUploadActive={dragUploadActive}
                      onDragEnter={handleUploadDragEnter}
                      onDragOver={handleUploadDragOver}
                      onDragLeave={handleUploadDragLeave}
                      onDrop={handleUploadDrop}
                      onSubmit={handleUpload}
                      fileInputRef={fileInputRef}
                      onFileChange={handleFileChange}
                      uploadCategory={uploadCategory}
                      onUploadCategoryChange={setUploadCategory}
                      categorySuggestions={categorySuggestions}
                      uploadQueueRunning={uploadQueueRunning}
                      fileHint={fileHint}
                      uploadQueueSummary={uploadQueueSummary}
                      uploadQueueExpanded={uploadQueueExpanded}
                      onToggleUploadQueueExpanded={() => setUploadQueueExpanded((prev) => !prev)}
                      onRetryFailedUploads={handleRetryFailedUploads}
                      canRetryFailedUploads={canRetryFailedUploads}
                      onClearCompletedUploads={handleClearCompletedUploads}
                      canClearUploadQueue={canClearUploadQueue}
                      uploadQueue={uploadQueue}
                    />
                  )}

                  <section className="notion-files-filter-shell" aria-labelledby="filters-title">
                    <h3 id="filters-title" className="sr-only">Filters</h3>
                    <div className="notion-filter-search-row">
                      <label htmlFor="search-input" className="sr-only">
                        Search
                      </label>
                      <div className="input-with-icon notion-files-searchbar-input">
                        <svg aria-hidden="true" viewBox="0 0 24 24">
                          <path d="M21 21l-4.3-4.3m1.3-4.7a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        <input
                          id="search-input"
                          ref={searchInputRef}
                          type="search"
                          placeholder="Search notes by title, tag, category, or content"
                          inputMode="search"
                          value={searchDraft}
                          onChange={(event) => setSearchDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              applySearch();
                            }
                          }}
                        />
                      </div>
                    </div>
                    <div className="notion-files-filter-strip">
                      <div className="notion-files-filter-main">
                        <div className="notion-quick-filter-presets" role="group" aria-label="Quick date filters">
                          {FILTER_DATE_RANGE_OPTIONS.map((option) => (
                            <button
                              key={`quick-range-${option.id}`}
                              type="button"
                              className={`notion-quick-preset-btn${
                                activeDateRangePresetId === option.id ? ' active' : ''
                              }`}
                              onClick={() => applyQuickDateRange(option.daysBack)}
                              aria-pressed={activeDateRangePresetId === option.id ? 'true' : 'false'}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                        {(activeSavedView || activeFilterChips.length > 0) && (
                          <div className="notion-active-filters" aria-label="Active filters">
                            {activeSavedView && (
                              <span className="notion-active-filter-chip notion-active-filter-chip-accent">
                                <span>View: {activeSavedView.name}</span>
                                <button
                                  type="button"
                                  onClick={resetDocumentsView}
                                  aria-label={`Clear saved view ${activeSavedView.name}`}
                                >
                                  ×
                                </button>
                              </span>
                            )}
                            {activeFilterChips.map((chip) => (
                              <span key={chip.id} className="notion-active-filter-chip">
                                <span>{chip.label}</span>
                                <button
                                  type="button"
                                  onClick={() => clearSingleFilter(chip.id)}
                                  aria-label={`Clear ${chip.label}`}
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="notion-files-filter-strip-actions">
                        <button
                          type="button"
                          className="btn notion-files-reset-view-btn"
                          onClick={() => void fetchDocuments(documentsPage)}
                          disabled={documentsLoading || bulkActionLoading || selectAllMatchedLoading}
                        >
                          {documentsLoading ? 'Refreshing...' : 'Refresh'}
                        </button>
                        <button
                          type="button"
                          className={`btn notion-files-filter-toggle${advancedFiltersOpen ? ' active' : ''}`}
                          onClick={() => setAdvancedFiltersOpen((prev) => !prev)}
                          aria-expanded={advancedFiltersOpen ? 'true' : 'false'}
                          aria-controls="advanced-filters-panel"
                        >
                          {advancedFiltersOpen ? 'Hide Filters' : 'Advanced Filters'}
                          {advancedFilterCount > 0 ? ` (${advancedFilterCount})` : ''}
                        </button>
                        <button
                          type="button"
                          className="btn notion-files-reset-view-btn"
                          onClick={resetDocumentsView}
                          disabled={!canResetFilesView}
                        >
                          Reset View
                        </button>
                        <div className="notion-files-saved-views-menu" ref={savedViewsMenuRef}>
                          <button
                            type="button"
                            className={`btn notion-files-secondary-trigger notion-files-views-trigger${savedViewsMenuOpen ? ' active' : ''}`}
                            onClick={() => setSavedViewsMenuOpen((prev) => !prev)}
                            aria-expanded={savedViewsMenuOpen ? 'true' : 'false'}
                            aria-haspopup="dialog"
                          >
                            Views
                          </button>
                          {savedViewsMenuOpen && (
                            <div className="notion-files-saved-views-popover" role="dialog" aria-label="Saved views">
                              <div className="notion-files-saved-views-section-head">
                                <div>
                                  <strong>Saved Views</strong>
                                  <p>Reuse search, filters, sort, and layout with one click.</p>
                                </div>
                                <button
                                  type="button"
                                  className="btn"
                                  onClick={() => {
                                    setSavedViewsMenuOpen(false);
                                    void handleSaveCurrentView();
                                  }}
                                >
                                  Save Current
                                </button>
                              </div>
                              <div className="notion-files-saved-views-popover-actions">
                                <button
                                  type="button"
                                  className="btn"
                                  onClick={() => {
                                    setSavedViewsMenuOpen(false);
                                    handleOpenSavedViewsImport();
                                  }}
                                >
                                  Import
                                </button>
                                <button
                                  type="button"
                                  className="btn"
                                  onClick={() => {
                                    setSavedViewsMenuOpen(false);
                                    handleExportSavedViews();
                                  }}
                                  disabled={!savedViews.length}
                                >
                                  Export
                                </button>
                              </div>
                              {savedViews.length ? (
                                <div className="notion-saved-views-list">
                                  {savedViews.map((view, index) => (
                                    <div
                                      key={view.id}
                                      className={`notion-saved-view-item${activeSavedViewId === view.id ? ' active' : ''}`}
                                    >
                                      <button
                                        type="button"
                                        className="notion-saved-view-main"
                                        onClick={() => {
                                          setSavedViewsMenuOpen(false);
                                          handleApplySavedView(view);
                                        }}
                                      >
                                        {view.pinned ? '📌 ' : ''}
                                        {view.name}
                                      </button>
                                      <button
                                        type="button"
                                        className={`notion-saved-view-icon${view.pinned ? ' is-active' : ''}`}
                                        onClick={() => handleTogglePinSavedView(view)}
                                        aria-label={view.pinned ? `Unpin ${view.name}` : `Pin ${view.name}`}
                                        title={view.pinned ? 'Unpin' : 'Pin to Top'}
                                      >
                                        📌
                                      </button>
                                      <button
                                        type="button"
                                        className="notion-saved-view-icon"
                                        onClick={() => handleMoveSavedView(view, -1)}
                                        aria-label={`Move ${view.name} up`}
                                        title="Move Up"
                                        disabled={index === 0}
                                      >
                                        ↑
                                      </button>
                                      <button
                                        type="button"
                                        className="notion-saved-view-icon"
                                        onClick={() => handleMoveSavedView(view, 1)}
                                        aria-label={`Move ${view.name} down`}
                                        title="Move Down"
                                        disabled={index === savedViews.length - 1}
                                      >
                                        ↓
                                      </button>
                                      <button
                                        type="button"
                                        className="notion-saved-view-icon"
                                        onClick={() => {
                                          setSavedViewsMenuOpen(false);
                                          void handleRenameSavedView(view);
                                        }}
                                        aria-label={`Rename ${view.name}`}
                                        title="Rename"
                                      >
                                        ✎
                                      </button>
                                      <button
                                        type="button"
                                        className="notion-saved-view-icon"
                                        onClick={() => {
                                          setSavedViewsMenuOpen(false);
                                          void handleDeleteSavedView(view);
                                        }}
                                        aria-label={`Delete ${view.name}`}
                                        title="Delete"
                                      >
                                        ×
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="notion-settings-help">
                                  No saved views yet. Save the current search, filters, and layout to reuse it later.
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {advancedFiltersOpen && (
                      <div id="advanced-filters-panel" className="notion-advanced-filters" aria-label="Advanced filters">
                        <div className="notion-files-advanced-head">
                          <strong>Advanced Filters</strong>
                          <p>Date, type, category, and tag controls stay tucked away until you need them.</p>
                        </div>
                        <div className="filter-row notion-filter-date-row">
                          <div className="date-group notion-date-group">
                            <label htmlFor="start-date" className="notion-date-field">
                              <span>Start</span>
                              <div className="date-input-wrapper" data-filled={filters.start ? 'true' : 'false'}>
                                <input
                                  id="start-date"
                                  type="date"
                                  lang="en-US"
                                  value={filters.start}
                                  onChange={(event) => {
                                    setDocumentsPage(1);
                                    setFilters((prev) => ({ ...prev, start: event.target.value }));
                                  }}
                                />
                                <span className="date-faux">{formatDisplayDate(filters.start)}</span>
                              </div>
                            </label>
                            <label htmlFor="end-date" className="notion-date-field">
                              <span>End</span>
                              <div className="date-input-wrapper" data-filled={filters.end ? 'true' : 'false'}>
                                <input
                                  id="end-date"
                                  type="date"
                                  lang="en-US"
                                  value={filters.end}
                                  onChange={(event) => {
                                    setDocumentsPage(1);
                                    setFilters((prev) => ({ ...prev, end: event.target.value }));
                                  }}
                                />
                                <span className="date-faux">{formatDisplayDate(filters.end)}</span>
                              </div>
                            </label>
                          </div>
                        </div>
                        <div className="tags-row notion-type-filter-row">
                          <span className="muted">Type:</span>
                          <div className="tags notion-type-filter-tags" role="list" aria-label="File type filters">
                            {FILE_TYPE_FILTER_OPTIONS.map((option) => {
                              const normalizedValue = normalizeFileTypeFilter(option.value);
                              const isSelected = normalizeFileTypeFilter(filters.fileType) === option.value;
                              const optionCount = Math.max(0, Number(fileTypeFilterCounts[normalizedValue] || 0));
                              return (
                                <button
                                  key={`file-type-${option.value || 'all'}`}
                                  type="button"
                                  className={`tag ${isSelected ? 'selected' : ''}`}
                                  role="listitem"
                                  onClick={() => {
                                    setSelectedDocumentIds([]);
                                    setDocumentsPage(1);
                                    setFilters((prev) => ({
                                      ...prev,
                                      fileType: isSelected ? '' : option.value,
                                    }));
                                  }}
                                >
                                  {option.label} ({optionCount})
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div className="tags-row">
                          <span className="muted">Category:</span>
                          <div className="tags" role="list" aria-label="Category filters">
                            <button
                              type="button"
                              className={`tag ${filters.category === '' ? 'selected' : ''}`}
                              role="listitem"
                              onClick={() => {
                                setDocumentsPage(1);
                                setFilters((prev) => ({ ...prev, category: '' }));
                              }}
                            >
                              All
                            </button>
                            {categories.map((category) => (
                              <button
                                type="button"
                                key={category}
                                className={`tag ${filters.category === category ? 'selected' : ''}`}
                                role="listitem"
                                onClick={() => {
                                  setDocumentsPage(1);
                                  setFilters((prev) => ({
                                    ...prev,
                                    category: prev.category === category ? '' : category,
                                  }));
                                }}
                              >
                                {category}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="tags-row">
                          <span className="muted">Tags:</span>
                          <div id="tags-container" className="tags" role="list" aria-label="Tag filters">
                            {tags.length ? (
                              tags.map((tag) => (
                                <button
                                  type="button"
                                  key={tag}
                                  className={`tag ${filters.tag === tag ? 'selected' : ''}`}
                                  role="listitem"
                                  onClick={() => {
                                    setDocumentsPage(1);
                                    setFilters((prev) => ({
                                      ...prev,
                                      tag: prev.tag === tag ? '' : tag,
                                    }));
                                  }}
                                >
                                  {tag}
                                </button>
                              ))
                            ) : (
                              <span className="muted">No tags</span>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </section>

                  <section className="notion-files-results" aria-labelledby="docs-title">
                    <div className="notion-files-results-head">
                      <div className="notion-files-results-summary">
                        <h2 id="docs-title" className="notion-files-results-title">
                          {documentsTotal} note{documentsTotal === 1 ? '' : 's'}
                        </h2>
                        <div className="notion-summary-chips" aria-live="polite">
                          <span className="notion-summary-chip">On this page {filteredDocuments.length}</span>
                          {activeFilterCount > 0 && (
                            <span className="notion-summary-chip">
                              {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="notion-results-controls">
                        <div className="notion-results-control notion-view-toggle" role="group" aria-label="Document layout">
                          <span>Layout</span>
                          <div className="notion-view-toggle-buttons">
                            {DOCUMENTS_LAYOUT_OPTIONS.map((option) => (
                              <button
                                key={`layout-${option.value}`}
                                type="button"
                                className={`notion-view-toggle-btn ${
                                  documentsLayout === option.value ? 'active' : ''
                                }`}
                                onClick={() => setDocumentsLayout(option.value)}
                                disabled={documentsLoading || bulkActionLoading || selectAllMatchedLoading}
                                aria-pressed={documentsLayout === option.value ? 'true' : 'false'}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <label className="notion-results-control" htmlFor="documents-sort-select">
                          <span>Sort</span>
                          <select
                            id="documents-sort-select"
                            value={documentsSort}
                            onChange={(event) => {
                              setDocumentsSort(normalizeDocumentsSort(event.target.value));
                              setDocumentsPage(1);
                            }}
                            disabled={documentsLoading || bulkActionLoading || selectAllMatchedLoading}
                          >
                            {DOCUMENTS_SORT_OPTIONS.map((item) => (
                              <option key={item.value} value={item.value}>
                                {item.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="notion-results-control" htmlFor="documents-page-size-select">
                          <span>Per page</span>
                          <select
                            id="documents-page-size-select"
                            value={documentsPageSize}
                            onChange={(event) => {
                              setDocumentsPageSize(
                                normalizeDocumentsPageSize(Number(event.target.value) || DEFAULT_DOCUMENTS_PAGE_SIZE)
                              );
                              setDocumentsPage(1);
                            }}
                            disabled={documentsLoading || bulkActionLoading || selectAllMatchedLoading}
                          >
                            {DOCUMENTS_PAGE_SIZE_OPTIONS.map((size) => (
                              <option key={`docs-page-size-${size}`} value={size}>
                                {size}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </div>
                    {!!selectedDocumentCount && (
                      <div className="notion-summary-actions notion-files-selection-actions">
                        <span className="notion-summary-chip is-selected">{selectedDocumentCount} selected</span>
                        {!!selectedOutsideCurrentPageCount && (
                          <span className="notion-summary-chip">
                            {selectedOutsideCurrentPageCount} from other page(s)
                          </span>
                        )}
                        <button
                          type="button"
                          className="btn"
                          onClick={handleSelectAllMatchedDocuments}
                          disabled={
                            !documentsTotal ||
                            documentsLoading ||
                            bulkActionLoading ||
                            selectAllMatchedLoading
                          }
                        >
                          {selectAllMatchedLoading ? 'Selecting Matched...' : 'Select Matched'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={toggleSelectAllDocumentsOnPage}
                          disabled={
                            !visibleDocumentIds.length ||
                            documentsLoading ||
                            bulkActionLoading ||
                            selectAllMatchedLoading
                          }
                        >
                          {allDocumentsSelectedOnPage ? 'Unselect Page' : 'Select Page'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={clearSelectedDocuments}
                          disabled={documentsLoading || bulkActionLoading || selectAllMatchedLoading}
                        >
                          Clear Selection
                        </button>
                      </div>
                    )}
                  {!!selectedDocumentCount && (
                    <section className="notion-bulk-panel" aria-label="Bulk actions">
                      <div className="notion-bulk-panel-head">
                        <h3>{selectedDocumentCount} selected</h3>
                        <p>Edit selected notes together or move them to Trash.</p>
                      </div>
                      <div className="notion-bulk-controls">
                        <label className="notion-results-control" htmlFor="bulk-category-input">
                          <span>Set category</span>
                          <input
                            id="bulk-category-input"
                            type="text"
                            list="bulk-category-options"
                            placeholder="Leave empty for Uncategorized"
                            value={bulkCategoryDraft}
                            onChange={(event) => setBulkCategoryDraft(event.target.value)}
                            disabled={bulkActionLoading || documentsLoading || selectAllMatchedLoading}
                          />
                        </label>
                        <datalist id="bulk-category-options">
                          {categorySuggestions.map((category) => (
                            <option key={`bulk-category-${category}`} value={category} />
                          ))}
                        </datalist>
                        <button
                          type="button"
                          className="btn"
                          onClick={handleBulkApplyCategory}
                          disabled={bulkActionLoading || documentsLoading || selectAllMatchedLoading}
                        >
                          Apply Category
                        </button>
                        <label className="notion-results-control" htmlFor="bulk-tags-input">
                          <span>Set tags</span>
                          <input
                            id="bulk-tags-input"
                            type="text"
                            placeholder="e.g. exam, chapter-3"
                            value={bulkTagsDraft}
                            onChange={(event) => setBulkTagsDraft(event.target.value)}
                            disabled={bulkActionLoading || documentsLoading || selectAllMatchedLoading}
                          />
                        </label>
                        <button
                          type="button"
                          className="btn"
                          onClick={handleBulkApplyTags}
                          disabled={bulkActionLoading || documentsLoading || selectAllMatchedLoading}
                        >
                          Apply Tags
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={handleBulkSummarizeSelected}
                          disabled={
                            bulkActionLoading ||
                            documentsLoading ||
                            selectAllMatchedLoading ||
                            !activeWorkspaceSettings.allow_ai_tools
                          }
                          title={
                            activeWorkspaceSettings.allow_ai_tools
                              ? undefined
                              : 'AI is disabled in workspace settings'
                          }
                        >
                          Summarize Selected
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => handleBulkSummarizeSelected({ forceRefresh: true })}
                          disabled={
                            bulkActionLoading ||
                            documentsLoading ||
                            selectAllMatchedLoading ||
                            !activeWorkspaceSettings.allow_ai_tools
                          }
                          title={
                            activeWorkspaceSettings.allow_ai_tools
                              ? 'Bypass cache and regenerate selected summaries'
                              : 'AI is disabled in workspace settings'
                          }
                        >
                          Rebuild Selected
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={handleBulkAddToStarred}
                          disabled={bulkActionLoading || documentsLoading || selectAllMatchedLoading}
                        >
                          Add Starred
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={handleBulkRemoveFromStarred}
                          disabled={bulkActionLoading || documentsLoading || selectAllMatchedLoading}
                        >
                          Remove Starred
                        </button>
                        <button
                          type="button"
                          className="btn btn-delete"
                          onClick={handleBulkDelete}
                          disabled={bulkActionLoading || documentsLoading || selectAllMatchedLoading}
                        >
                          {bulkActionLoading ? 'Processing...' : 'Move to Trash'}
                        </button>
                      </div>
                    </section>
                  )}
                  {bulkResultSummary && (
                    <section
                      className={`notion-bulk-result${bulkResultSummary.failed ? ' is-warning' : ' is-success'}`}
                      aria-live="polite"
                    >
                      <div className="notion-bulk-result-head">
                        <div>
                          <strong>{bulkResultSummary.action}</strong>
                          <p>
                            {bulkResultSummary.succeeded} succeeded / {bulkResultSummary.total} total
                            {bulkResultSummary.failed
                              ? ` · ${bulkResultSummary.failed} failed`
                              : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="btn"
                          onClick={dismissBulkResultSummary}
                        >
                          Dismiss
                        </button>
                      </div>
                      {bulkResultSummary.failed > 0 && (
                        <details className="notion-bulk-fail-details">
                          <summary>View failure details</summary>
                          <ul className="notion-bulk-fail-list">
                            {(bulkResultSummary.failedItems || []).map((item) => (
                              <li key={`${bulkResultSummary.updatedAt}-${item.id}`}>
                                #{item.id}: {item.message}
                              </li>
                            ))}
                            {!!bulkResultSummary.hiddenFailedCount && (
                              <li>
                                ...and {bulkResultSummary.hiddenFailedCount} more failed item(s).
                              </li>
                            )}
                          </ul>
                        </details>
                      )}
                    </section>
                  )}
                  {documentsLoadError && <p className="muted tiny">Load failed: {documentsLoadError}</p>}
                  {documentsLoading && !documentsLoadError && (
                    <p className="muted tiny">Loading notes...</p>
                  )}
                  <Suspense fallback={<p className="muted tiny">Loading document list...</p>}>
                    <DocumentsList
                      documents={filteredDocuments}
                      isLoggedIn={isLoggedIn}
                      meta={`Workspace: ${activeWorkspace?.name || 'Unknown'} · Showing ${filteredDocuments.length} item(s) on page ${documentsPage} of ${documentsPageCount} (${documentsTotal} matched)${selectedDocumentCount ? ` · ${selectedDocumentCount} selected` : ''}`}
                      canEditMetadata={activeWorkspaceSettings.allow_note_editing}
                      canSummarize={activeWorkspaceSettings.allow_ai_tools}
                      canRunImageOcr={activeWorkspaceSettings.allow_ai_tools && activeWorkspaceSettings.allow_ocr}
                      canShare={
                        activeWorkspaceSettings.link_sharing_mode !== 'restricted' &&
                        canCurrentUserManageShareLinks
                      }
                      starredDocIdSet={starredDocIdSet}
                      onView={handleView}
                      onDelete={handleDelete}
                      onEdit={handleEdit}
                      onEditCategory={handleEditCategory}
                      onRename={handleRenameDocument}
                      onSummarize={handleUseDocumentForAI}
                      onSummarizeRefresh={handleRegenerateDocumentSummary}
                      onRunImageOcr={handleRunDocumentImageOcr}
                      onToggleStar={handleToggleStarredNote}
                      onShare={handleShareDocument}
                      hasActiveFilters={hasActiveFilters}
                      onClearFilters={clearFilters}
                      selectionEnabled={isLoggedIn}
                      selectionDisabled={documentsLoading || bulkActionLoading || selectAllMatchedLoading}
                      selectedDocumentIds={selectedDocumentIds}
                      onToggleDocumentSelection={toggleDocumentSelection}
                      layout={documentsLayout}
                      searchQuery={filters.query}
                    />
                  </Suspense>
                  {documentsPageCount > 1 && (
                    <div className="notion-doc-pagination">
                      <span className="muted tiny">
                        Page {documentsPage} / {documentsPageCount}
                      </span>
                      <div className="notion-doc-pagination-actions">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setDocumentsPage((prev) => Math.max(1, prev - 1))}
                          disabled={documentsPage <= 1 || documentsLoading}
                        >
                          Previous
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setDocumentsPage((prev) => Math.min(documentsPageCount, prev + 1))}
                          disabled={documentsPage >= documentsPageCount || documentsLoading}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              </section>
              </div>
            </section>
          )}
        </main>
      </div>

      <input
        ref={ocrImageInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={handleOcrImageChange}
      />

      <SendNoteByEmailModal
        open={activeDocShareEmailOpen}
        mode={activeDocShareModalMode}
        onClose={closeActiveDocShareEmailModal}
        onSubmit={handleSendActiveDocByEmail}
        onSendAnother={handleActiveDocShareSendAnother}
        onCopyLink={handleCopySentActiveDocShareLink}
        onBackToSend={activeDoc?.id ? handleActiveDocShareSendAnother : null}
        recipientEmail={activeDocShareEmailRecipient}
        onRecipientEmailChange={setActiveDocShareEmailRecipient}
        message={activeDocShareEmailMessage}
        onMessageChange={setActiveDocShareEmailMessage}
        expiryDays={activeDocShareEmailExpiryDays}
        onExpiryDaysChange={setActiveDocShareEmailExpiryDays}
        isSubmitting={activeDocShareEmailSending}
        documentTitle={activeDoc?.title || activeDoc?.filename || 'Untitled Note'}
        linkModeLabel={activeDocShareModeLabel}
        successResult={activeDocShareEmailResult}
        successExpiryLabel={activeDocShareEmailExpiryLabel}
        manageLinksContent={activeDocShareLinksManagerContent}
        canManageLinks={canOpenWorkspaceShareManagement}
      />

      <SummaryResultModal
        open={summaryResultOpen}
        onClose={closeSummaryResultModal}
        title="Summary Result"
        summaryTitle={summaryResultTitle}
        analysisResult={analysisResult}
        onCopySummary={handleCopySummary}
        onExportSummary={handleExportSummary}
        onExportSummaryPdf={handleExportSummaryPdf}
        onEmailSummary={handleEmailSummary}
        onRebuildSummary={handleRebuildCurrentSummaryResult}
        canRebuildSummary={summaryResultRebuildDocId > 0}
        rebuildSummaryLoading={summaryResultRebuildLoading}
        closeLabel={summaryResultReturnToCenter ? 'Back to Summaries' : 'Close'}
        allowExport={activeWorkspaceSettings.allow_export}
      />

      <OcrResultModal
        open={ocrResultOpen && !summaryResultOpen}
        onClose={closeOcrResultModal}
        sourceLabel={ocrSourceContext?.title || ''}
        sourceDetail={ocrSourceContext?.detail || ''}
        extractedText={extractedText}
        onChangeExtractedText={setExtractedText}
        saveFormat={ocrSaveFormat}
        onSaveFormatChange={setOcrSaveFormat}
        onSave={handleSaveOcrResult}
        onSummarize={handleAnalyzeText}
        isExtracting={isExtracting}
        isAnalyzing={isAnalyzing}
        isSaving={isSavingOcrResult}
        canSave={isLoggedIn}
        canSummarize={isLoggedIn && activeWorkspaceSettings.allow_ai_tools}
      />

      <SummaryCenterModal
        open={summaryCenterOpen}
        onClose={() => setSummaryCenterOpen(false)}
        summaryHistory={summaryHistory}
        summaryHistoryStats={summaryHistoryStats}
        summaryProgress={summaryProgress}
        summaryProgressLabel={summaryProgressLabel}
        query={summaryCenterQuery}
        onQueryChange={setSummaryCenterQuery}
        source={summaryCenterSource}
        onSourceChange={(value) => setSummaryCenterSource(normalizeSummaryCenterSource(value))}
        sort={summaryCenterSort}
        onSortChange={(value) => setSummaryCenterSort(normalizeSummaryCenterSort(value))}
        model={summaryCenterModel}
        onModelChange={(value) => setSummaryCenterModel(String(value || 'all').trim() || 'all')}
        chunk={summaryCenterChunk}
        onChunkChange={(value) => setSummaryCenterChunk(normalizeSummaryCenterChunkFilter(value))}
        sourceOptions={SUMMARY_CENTER_SOURCE_OPTIONS}
        sortOptions={SUMMARY_CENTER_SORT_OPTIONS}
        chunkOptions={SUMMARY_CENTER_CHUNK_OPTIONS}
        modelOptions={summaryCenterModelOptions}
        items={summaryHistoryItems}
        expandedIds={summaryCenterExpandedIds}
        onClearAll={handleClearSummaryHistory}
        onApplyItem={handleApplySummaryHistoryItem}
        onOpenItemDocument={(entry) => {
          const targetId = toPositiveDocId(entry?.docId);
          if (!targetId) return;
          setSummaryCenterOpen(false);
          void openDocumentInPane(targetId, { fromSidebar: true });
        }}
        onToggleExpanded={toggleSummaryHistoryExpanded}
        onDeleteItem={removeSummaryHistoryEntry}
        getSummarySourceLabel={getSummarySourceLabel}
        formatDateTimeLabel={formatDateTimeLabel}
      />

      <TrashModal
        open={trashModalOpen}
        onClose={() => setTrashModalOpen(false)}
        trashRetentionDays={trashRetentionDays}
        trashTotal={trashTotal}
        selectedTrashCount={selectedTrashCount}
        trashQuery={trashQuery}
        onTrashQueryChange={(value) => {
          setTrashQuery(value);
          setTrashPage(1);
        }}
        trashSort={trashSort}
        onTrashSortChange={(value) => {
          setTrashSort(normalizeTrashSort(value));
          setTrashPage(1);
        }}
        trashSortOptions={TRASH_SORT_OPTIONS}
        trashPageSize={trashPageSize}
        onTrashPageSizeChange={(value) => {
          setTrashPageSize(normalizeTrashPageSize(Number(value) || TRASH_PAGE_SIZE_OPTIONS[1]));
          setTrashPage(1);
        }}
        trashPageSizeOptions={TRASH_PAGE_SIZE_OPTIONS}
        onRefresh={() => fetchTrashDocuments()}
        trashLoading={trashLoading}
        trashActionLoadingId={trashActionLoadingId}
        trashBulkActionLoading={trashBulkActionLoading}
        trashRangeStart={trashRangeStart}
        trashRangeEnd={trashRangeEnd}
        trashItems={trashItems}
        allTrashItemsSelectedOnPage={allTrashItemsSelectedOnPage}
        onToggleSelectAllOnPage={toggleSelectAllTrashOnPage}
        onClearSelection={clearSelectedTrashDocuments}
        onBulkRestore={handleBulkRestoreFromTrash}
        onBulkDeleteForever={handleBulkDeleteForeverFromTrash}
        trashPurgedCount={trashPurgedCount}
        trashLoadError={trashLoadError}
        selectedIdSet={trashSelectedIdSet}
        onToggleTrashDocumentSelection={toggleTrashDocumentSelection}
        onRestoreFromTrash={(item) => void handleRestoreFromTrash(item)}
        onDeleteForeverFromTrash={(item) => void handleDeleteForeverFromTrash(item)}
        trashPage={trashPage}
        trashPageCount={trashPageCount}
        onPreviousPage={() => setTrashPage((prev) => Math.max(1, prev - 1))}
        onNextPage={() => setTrashPage((prev) => Math.min(trashPageCount, prev + 1))}
        getDocExt={getDocExt}
        normalizeCategory={normalizeCategory}
        formatDateTimeLabel={formatDateTimeLabel}
      />

      {inputDialogState.open && (
        <div
          className="notion-modal-backdrop notion-confirm-backdrop"
          role="presentation"
          onClick={() => closeInputDialog(false)}
        >
          <section
            className="notion-modal-card notion-input-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="input-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="input-dialog-title">{inputDialogState.title}</h3>
            {inputDialogState.description && (
              <p className="notion-confirm-description">{inputDialogState.description}</p>
            )}
            <input
              type="text"
              value={inputDialogDraft}
              onChange={(event) => setInputDialogDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                const hasRequiredValue = !inputDialogState.required || Boolean(String(inputDialogDraft || '').trim());
                if (!hasRequiredValue) return;
                event.preventDefault();
                closeInputDialog(true);
              }}
              placeholder={inputDialogState.placeholder || ''}
              autoFocus
            />
            <div className="notion-confirm-actions">
              <button
                type="button"
                className={`btn${inputDialogState.danger ? ' btn-delete' : ' btn-primary'}`}
                onClick={() => closeInputDialog(true)}
                disabled={inputDialogState.required && !String(inputDialogDraft || '').trim()}
              >
                {inputDialogState.confirmLabel}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => closeInputDialog(false)}
              >
                {inputDialogState.cancelLabel}
              </button>
            </div>
          </section>
        </div>
      )}

      {confirmDialogState.open && (
        <div
          className="notion-modal-backdrop notion-confirm-backdrop"
          role="presentation"
          onClick={() => closeConfirmDialog(false)}
        >
          <section
            className="notion-modal-card notion-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="confirm-dialog-title">{confirmDialogState.title}</h3>
            {confirmDialogState.description && (
              <p className="notion-confirm-description">{confirmDialogState.description}</p>
            )}
            <div className="notion-confirm-actions">
              <button
                type="button"
                className={`btn${confirmDialogState.danger ? ' btn-delete' : ' btn-primary'}`}
                onClick={() => closeConfirmDialog(true)}
              >
                {confirmDialogState.confirmLabel}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => closeConfirmDialog(false)}
              >
                {confirmDialogState.cancelLabel}
              </button>
            </div>
          </section>
        </div>
      )}

      {workspaceManagerOpen && (
        <div
          className="notion-modal-backdrop"
          role="presentation"
          onClick={() => {
            if (workspaceActionLoading) return;
            setWorkspaceManagerOpen(false);
          }}
        >
          <section
            className="notion-modal-card notion-workspace-manager-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-manager-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="notion-settings-header">
              <div>
                <h3 id="workspace-manager-title">Manage Workspaces</h3>
                <p className="notion-settings-help">
                  Delete workspaces you own, or remove shared workspaces from your account.
                </p>
              </div>
              <button
                type="button"
                className="notion-modal-close"
                onClick={() => setWorkspaceManagerOpen(false)}
                disabled={workspaceActionLoading}
                aria-label="Close workspace manager"
              >
                ×
              </button>
            </header>

            <section className="notion-settings-block" aria-label="Workspace list">
              <ul className="notion-inline-list notion-workspace-manager-list">
                {(workspaceState.workspaces || []).length ? (
                  (workspaceState.workspaces || []).map((workspace) => {
                    const workspaceId = String(workspace?.id || '');
                    const workspaceName = workspace?.name || 'Untitled workspace';
                    const isOwnerWorkspace = workspace?.is_owner !== false;
                    const isCurrentWorkspace = workspaceId === activeWorkspaceId;
                    const memberCount = memberCountOfWorkspace(workspace, accountName);
                    return (
                      <li key={workspaceId || workspaceName}>
                        <span className="notion-workspace-manager-item">
                          <WorkspaceIcon
                            value={workspaceIconLabel(workspace, workspaceName || accountName)}
                            fallback={workspaceName || accountName}
                          />
                          <span>
                            <strong>{workspaceName}</strong>
                            <small>
                              {isOwnerWorkspace ? 'Owner' : 'Shared'}
                              {` · ${memberCount} member${memberCount === 1 ? '' : 's'}`}
                              {isCurrentWorkspace ? ' · Current' : ''}
                            </small>
                          </span>
                        </span>
                        <div className="notion-inline-list-actions">
                          <button
                            type="button"
                            className="notion-inline-list-remove"
                            onClick={() =>
                              isOwnerWorkspace
                                ? handleDeleteWorkspace(workspace)
                                : handleLeaveWorkspace(workspace)
                            }
                            disabled={workspaceActionLoading || workspaceLoading}
                          >
                            {isOwnerWorkspace ? 'Delete' : 'Remove'}
                          </button>
                        </div>
                      </li>
                    );
                  })
                ) : (
                  <li>
                    <span>No workspaces available</span>
                  </li>
                )}
              </ul>
            </section>

            <div className="notion-modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setWorkspaceManagerOpen(false)}
                disabled={workspaceActionLoading}
              >
                Close
              </button>
            </div>
          </section>
        </div>
      )}

      {accountManagerOpen && (
        <div
          className="notion-modal-backdrop"
          role="presentation"
          onClick={() => setAccountManagerOpen(false)}
        >
          <section
            className="notion-modal-card notion-account-manager-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-manager-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="account-manager-title">Account Manager</h3>
            <p className="notion-settings-help">
              Save multiple accounts and switch quickly. For security, selecting an account opens Sign in with that account prefilled.
            </p>

            <section className="notion-settings-block" aria-label="Saved accounts">
              <h4>Saved Accounts</h4>
              <ul className="notion-inline-list">
                {(savedAccounts || []).length ? (
                  savedAccounts.map((account) => (
                    <li key={account.username}>
                      <span>{account.username}</span>
                      <div className="notion-inline-list-actions">
                        <button
                          type="button"
                          className="notion-inline-list-switch"
                          onClick={() => handleSwitchAccount(account)}
                        >
                          Sign in
                        </button>
                        <button
                          type="button"
                          className="notion-inline-list-remove"
                          onClick={() => handleRemoveSavedAccount(account.username)}
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  ))
                ) : (
                  <li>
                    <span>No saved accounts</span>
                  </li>
                )}
              </ul>
            </section>

            <div className="notion-modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setAccountManagerOpen(false);
                  navigate('/login');
                }}
              >
                Add Account
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setAccountManagerOpen(false)}
              >
                Close
              </button>
            </div>
          </section>
        </div>
      )}

      {workspaceSettingsOpen && (
        <Suspense fallback={<p className="muted tiny">Loading settings...</p>}>
          <WorkspaceSettingsModal
            open={workspaceSettingsOpen}
            workspaceActionLoading={workspaceActionLoading}
            onClose={() => setWorkspaceSettingsOpen(false)}
            workspaceSettingsTabs={WORKSPACE_SETTINGS_TABS}
            workspaceSettingsTab={workspaceSettingsTab}
            setWorkspaceSettingsTab={setWorkspaceSettingsTab}
            workspaceSettingsDraft={workspaceSettingsDraft}
            updateWorkspaceSettingsDraft={updateWorkspaceSettingsDraft}
            workspaceNameDraft={workspaceNameDraft}
            setWorkspaceNameDraft={setWorkspaceNameDraft}
            onSaveWorkspaceSettings={handleSaveWorkspaceSettings}
            minSidebarRecentLimit={MIN_SIDEBAR_RECENT_LIMIT}
            maxSidebarRecentLimit={MAX_SIDEBAR_RECENT_LIMIT}
            defaultSidebarRecentLimit={DEFAULT_SIDEBAR_RECENT_LIMIT}
            sidebarDensityOptions={SIDEBAR_DENSITY_OPTIONS}
            accentColorPresets={WORKSPACE_ACCENT_PRESETS}
            onClearWorkspaceDocuments={handleClearWorkspaceDocuments}
            onDeleteWorkspace={handleDeleteWorkspace}
            isLoggedIn={isLoggedIn}
            activeWorkspace={activeWorkspace}
            onLeaveWorkspace={handleLeaveWorkspace}
            userNotificationPreferences={userNotificationPreferences}
            userNotificationPreferencesSaving={userNotificationPreferencesSaving}
            onChangeEmailNotifications={handleChangeEmailNotifications}
            workspaceInsights={{
              totalNotes: dashboardStats.total,
              categoryCount: dashboardStats.categories,
              tagCount: dashboardStats.tags,
              memberCount: workspaceMemberCount,
            }}
          />
        </Suspense>
      )}

      {workspaceInviteOpen && (
        <Suspense fallback={<p className="muted tiny">Loading invites...</p>}>
          <WorkspaceInviteModal
            open={workspaceInviteOpen}
            workspaceActionLoading={workspaceActionLoading}
            onClose={() => setWorkspaceInviteOpen(false)}
            isLoggedIn={isLoggedIn}
            workspaceInviteDraft={workspaceInviteDraft}
            onChangeWorkspaceInviteDraft={setWorkspaceInviteDraft}
            onInviteMembers={handleInviteMembers}
            latestInviteDelivery={latestInviteDelivery}
            workspaceSettingsDraft={workspaceSettingsDraft}
            updateWorkspaceSettingsDraft={updateWorkspaceSettingsDraft}
            onSaveWorkspaceAccessSettings={handleSaveWorkspaceAccessSettings}
            canManageAccessSettings={isLoggedIn && activeWorkspace?.is_owner !== false}
            canInviteMembers={
              !isLoggedIn ||
              activeWorkspace?.is_owner !== false ||
              Boolean(activeWorkspaceSettings.allow_member_invites)
            }
            inviteItems={inviteItems}
            onResendInvitation={handleResendInvitation}
            onRemoveInvite={handleRemoveInvite}
            memberItems={memberItems}
            currentUsername={username}
            canManageMembers={isLoggedIn && activeWorkspace?.is_owner !== false}
            onRemoveMember={handleRemoveWorkspaceMember}
          />
        </Suspense>
      )}

      {toastState.open && (
        <div className="notion-toast-stack" role="status" aria-live="polite">
          <div className={`notion-toast notion-toast-${toastState.tone}`}>
            <span>{toastState.message}</span>
            <button
              type="button"
              className="notion-toast-close"
              onClick={dismissToast}
              aria-label="Close notification"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
