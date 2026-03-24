import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import SummaryCenterModal from '../components/SummaryCenterModal.jsx';
import TrashModal from '../components/TrashModal.jsx';
import UploadPanel from '../components/UploadPanel.jsx';
import WorkspaceSidebar from '../components/WorkspaceSidebar.jsx';
import useDocumentsList from '../hooks/useDocumentsList.js';
import useUploadQueue from '../hooks/useUploadQueue.js';
import { todayKey } from '../lib/dates.js';
import { loadUsageMap, persistUsageMap } from '../lib/usage.js';
import { loadAccounts } from '../lib/accounts.js';
import {
  loadAccountHistory,
  persistAccountHistory,
  saveAccountToHistory,
  removeAccountFromHistory,
} from '../lib/accountHistory.js';
import { clearStoredAuthSession, logoutCurrentSession } from '../lib/authSession.js';
import {
  createWorkspace,
  loadWorkspaceState,
  persistWorkspaceState,
} from '../lib/workspaces.js';
import { coerceOcrText } from '../lib/ocr.js';

const DEFAULT_SIDEBAR_RECENT_LIMIT = 10;
const MIN_SIDEBAR_RECENT_LIMIT = 5;
const MAX_SIDEBAR_RECENT_LIMIT = 20;
const DEFAULT_DOCUMENTS_PAGE_SIZE = 20;
const DOCUMENTS_PAGE_SIZE_OPTIONS = [12, 20, 40];
const DEFAULT_DOCUMENTS_SORT = 'newest';
const DEFAULT_DOCUMENTS_LAYOUT = 'grid';
const DOCUMENTS_LAYOUT_OPTIONS = [
  { value: 'grid', label: 'Grid' },
  { value: 'compact', label: 'Compact' },
];
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
const isActiveShareLink = (item) =>
  String(item?.status || '').trim().toLowerCase() === 'active' && !Boolean(item?.is_expired ?? item?.isExpired);
const HOME_TAB_OPTIONS = ['home', 'files', 'ai'];
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
  { id: 'defaults', label: 'Defaults', description: 'File views, category rules, and landing behavior.' },
  { id: 'experience', label: 'Experience', description: 'Sidebar density and overview widgets.' },
  { id: 'notifications', label: 'Notifications', description: 'Control in-app upload, AI, and sharing toasts.' },
  { id: 'permissions', label: 'Permissions', description: 'What members can upload, edit, and export.' },
  { id: 'ai', label: 'AI', description: 'Summaries, OCR, and keyword defaults.' },
  { id: 'access', label: 'Access', description: 'Invites, trusted domains, and link sharing.' },
  { id: 'danger', label: 'Danger', description: 'Irreversible workspace cleanup actions.' },
];
const SHARE_POLICY_PRESETS = [
  {
    id: 'strict',
    label: 'Strict',
    description: 'Owner-only management, 3-day expiry, single active link.',
    patch: {
      link_sharing_mode: 'workspace',
      default_share_expiry_days: 3,
      max_active_share_links_per_document: 1,
      allow_member_share_management: false,
      auto_revoke_previous_share_links: true,
    },
  },
  {
    id: 'classroom',
    label: 'Classroom',
    description: 'Balanced default for team study with controlled link volume.',
    patch: {
      link_sharing_mode: 'workspace',
      default_share_expiry_days: 7,
      max_active_share_links_per_document: 5,
      allow_member_share_management: false,
      auto_revoke_previous_share_links: false,
    },
  },
  {
    id: 'open',
    label: 'Open',
    description: 'Public sharing enabled with higher active-link capacity.',
    patch: {
      link_sharing_mode: 'public',
      default_share_expiry_days: 14,
      max_active_share_links_per_document: 10,
      allow_member_share_management: true,
      auto_revoke_previous_share_links: false,
    },
  },
];
const KEYBOARD_SHORTCUT_ITEMS = [
  { keys: 'Ctrl/⌘ + K', action: 'Focus search and open Files view' },
  { keys: '/', action: 'Focus search (when not typing)' },
  { keys: 'Ctrl/⌘ + Shift + U', action: 'Open file picker' },
  { keys: 'Ctrl/⌘ + Shift + S', action: 'Save current view' },
  { keys: '?', action: 'Open shortcut help' },
  { keys: 'Esc', action: 'Close current modal/dialog' },
];
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
const QUICK_FILTER_PRESET_OPTIONS = [
  { id: 'recent7', label: 'Recent 7 Days' },
  { id: 'images', label: 'Images' },
  { id: 'editable', label: 'Editable' },
  { id: 'uncategorized', label: 'Uncategorized' },
];
const FILE_TYPE_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'DOCX' },
  { value: 'txt', label: 'TXT' },
  { value: 'image', label: 'Images' },
  { value: 'editable', label: 'Editable' },
];
const QUICK_TYPE_FILTER_OPTIONS = [
  { value: 'image', label: 'Images only' },
  { value: 'editable', label: 'Editable only' },
];
const FILE_TYPE_FILTER_VALUES = new Set(FILE_TYPE_FILTER_OPTIONS.map((option) => option.value));
const IMAGE_FILE_TYPE_VALUES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const EDITABLE_FILE_TYPE_VALUES = new Set(['txt', 'docx']);

const createClientId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const createSavedViewId = () => createClientId('view');
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
  if (!counts.editable) {
    counts.editable = (counts.txt || 0) + (counts.docx || 0);
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

const isTypingTarget = (target) => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
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

const normalizeWorkspaceSettings = (raw) => {
  const source = raw && typeof raw === 'object' ? raw : {};
  const workspaceIcon = String(source.workspace_icon || DEFAULT_WORKSPACE_SETTINGS.workspace_icon).trim();
  const summaryLength = SUMMARY_LENGTH_OPTIONS.includes(String(source.summary_length || '').toLowerCase())
    ? String(source.summary_length).toLowerCase()
    : DEFAULT_WORKSPACE_SETTINGS.summary_length;
  const linkMode = LINK_SHARING_MODES.includes(String(source.link_sharing_mode || '').toLowerCase())
    ? String(source.link_sharing_mode).toLowerCase()
    : DEFAULT_WORKSPACE_SETTINGS.link_sharing_mode;
  const defaultHomeTab = HOME_TAB_OPTIONS.includes(String(source.default_home_tab || '').toLowerCase())
    ? String(source.default_home_tab).toLowerCase()
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

  return {
    workspace_icon: workspaceIcon.slice(0, 2) || DEFAULT_WORKSPACE_SETTINGS.workspace_icon,
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

const normalizeDocument = (doc) => ({
  ...doc,
  uploadedAt: doc.uploaded_at ?? doc.uploadedAt ?? '',
  deletedAt: doc.deleted_at ?? doc.deletedAt ?? '',
  lastAccessAt: doc.last_access_at ?? doc.lastAccessAt ?? '',
  contentHtml: doc.content_html ?? doc.contentHtml ?? '',
  category: normalizeCategory(doc.category),
  content: String(doc.content || ''),
  tags: normalizeTags(doc.tags),
});

const workspaceIconLabel = (workspace, fallback = 'W') => {
  const icon = String(workspace?.settings?.workspace_icon || '').trim();
  if (icon) return icon.slice(0, 2);
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

const buildFileTypeCountsFromDocuments = (docs) => {
  const counts = {};
  (Array.isArray(docs) ? docs : []).forEach((doc) => {
    const ext = String(getDocExt(doc) || '').trim().toLowerCase();
    if (!ext) return;
    counts[ext] = (counts[ext] || 0) + 1;
    if (IMAGE_FILE_TYPE_VALUES.has(ext)) {
      counts.image = (counts.image || 0) + 1;
    }
    if (EDITABLE_FILE_TYPE_VALUES.has(ext)) {
      counts.editable = (counts.editable || 0) + 1;
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
const AIAssistantPanel = lazy(() => import('../components/AIAssistantPanel.jsx'));
const WorkspaceSettingsModal = lazy(() => import('../components/WorkspaceSettingsModal.jsx'));
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
  const workspaceMenuRef = useRef(null);
  const recentMenuRef = useRef(null);
  const searchInputRef = useRef(null);
  const savedViewsImportInputRef = useRef(null);
  const trashRequestSeqRef = useRef(0);
  const aiImageInputRef = useRef(null);
  const toastTimerRef = useRef(null);
  const confirmResolverRef = useRef(null);
  const inputDialogResolverRef = useRef(null);
  const summaryProgressTimerRef = useRef(null);
  const [isLoggedIn, setIsLoggedIn] = useState(
    () => Boolean(sessionStorage.getItem('username') && sessionStorage.getItem('auth_token'))
  );
  const [showFiles, setShowFiles] = useState(() => location.state?.showFiles || false);
  const [showAI, setShowAI] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [workspaceInviteOpen, setWorkspaceInviteOpen] = useState(false);
  const [accountManagerOpen, setAccountManagerOpen] = useState(false);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceActionLoading, setWorkspaceActionLoading] = useState(false);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState('');
  const [workspaceSettingsDraft, setWorkspaceSettingsDraft] = useState(() =>
    normalizeWorkspaceSettings(DEFAULT_WORKSPACE_SETTINGS)
  );
  const [workspaceSettingsTab, setWorkspaceSettingsTab] = useState('general');
  const [workspaceInviteDraft, setWorkspaceInviteDraft] = useState('');
  const [latestInviteLinks, setLatestInviteLinks] = useState([]);
  const [latestInviteDelivery, setLatestInviteDelivery] = useState(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [accountDraft, setAccountDraft] = useState({ username: '', email: '' });
  const [savedAccounts, setSavedAccounts] = useState(() => {
    const fromHistory = normalizeAccounts(loadAccountHistory());
    if (fromHistory.length) return fromHistory;
    const legacy = normalizeAccounts(loadAccounts());
    return legacy;
  });
  const [workspaceState, setWorkspaceState] = useState(() =>
    loadWorkspaceState(sessionStorage.getItem('username') || 'Guest')
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
  const [activeDocShareLinks, setActiveDocShareLinks] = useState([]);
  const [activeDocShareLinksLoading, setActiveDocShareLinksLoading] = useState(false);
  const [activeDocShareLinksError, setActiveDocShareLinksError] = useState('');
  const [activeDocShareActionLoadingId, setActiveDocShareActionLoadingId] = useState(0);
  const [activeDocShareActionLoadingType, setActiveDocShareActionLoadingType] = useState('');
  const docPaneVisible = activeDocLoading || Boolean(activeDocError) || Boolean(activeDoc);
  const [extractedText, setExtractedText] = useState('');
  const [aiHideInputText, setAiHideInputText] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [summaryProgress, setSummaryProgress] = useState(DEFAULT_SUMMARY_PROGRESS);
  const [uploadCategory, setUploadCategory] = useState('');
  const [usageMap, setUsageMap] = useState(() => loadUsageMap());
  const sessionStartRef = useRef(null);
  const [now, setNow] = useState(() => new Date());

  const storedUsername = sessionStorage.getItem('username') || '';
  const authToken = sessionStorage.getItem('auth_token') || '';
  const username = authToken ? storedUsername : '';
  const accountName = storedUsername || 'Guest';
  const accountEmail = authToken ? (sessionStorage.getItem('email') || (storedUsername ? `${storedUsername}` : '')) : '';
  const activeWorkspace = useMemo(() => {
    if (!workspaceState?.workspaces?.length) return null;
    return (
      workspaceState.workspaces.find((item) => item.id === workspaceState.activeWorkspaceId) ||
      workspaceState.workspaces[0]
    );
  }, [workspaceState]);
  const activeWorkspaceId = String(activeWorkspace?.id || workspaceState?.activeWorkspaceId || '');
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
  const trustedInviteDomains = useMemo(
    () => parseWorkspaceDomainList(activeWorkspaceSettings.allowed_email_domains),
    [activeWorkspaceSettings.allowed_email_domains]
  );
  const enabledWorkspaceNotificationCount = useMemo(
    () =>
      [
        activeWorkspaceSettings.notify_upload_events,
        activeWorkspaceSettings.notify_summary_events,
        activeWorkspaceSettings.notify_sharing_events,
      ].filter(Boolean).length,
    [
      activeWorkspaceSettings.notify_upload_events,
      activeWorkspaceSettings.notify_summary_events,
      activeWorkspaceSettings.notify_sharing_events,
    ]
  );
  const canCurrentUserManageShareLinks = useMemo(() => {
    if (!isLoggedIn || !username || !activeWorkspace) return false;
    if (activeWorkspace.is_owner === false && !activeWorkspaceSettings.allow_member_share_management) {
      return false;
    }
    return true;
  }, [
    activeWorkspace,
    activeWorkspaceSettings.allow_member_share_management,
    isLoggedIn,
    username,
  ]);
  const activeSharePolicyPresetId = useMemo(() => {
    const matched = SHARE_POLICY_PRESETS.find((preset) =>
      Object.entries(preset.patch).every(
        ([key, value]) => String(workspaceSettingsDraft?.[key]) === String(value)
      )
    );
    return matched?.id || '';
  }, [workspaceSettingsDraft]);
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
    if (summaryCenterModel === 'all') return;
    if (summaryCenterModelOptions.includes(summaryCenterModel)) return;
    setSummaryCenterModel('all');
  }, [summaryCenterModel, summaryCenterModelOptions]);
  const workspaceMemberCount = useMemo(
    () => memberCountOfWorkspace(activeWorkspace, accountName),
    [activeWorkspace, accountName]
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
  const workspaceInviteLink = useMemo(() => {
    if (latestInviteLinks.length) return latestInviteLinks[0];
    const latestInvite = inviteItems.find((item) => typeof item === 'object' && item?.invite_url);
    return latestInvite?.invite_url || '';
  }, [latestInviteLinks, inviteItems]);

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
    hasAdvancedFilters,
    activeDateRangePresetId,
    activeQuickFilterPresetId,
    activeFilterChips,
    currentViewSnapshot,
    resetDocumentsData,
  } = useDocumentsList({
    username,
    authToken,
    activeWorkspaceId,
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
      const current = nextState.workspaces.find((item) => item.id === nextState.activeWorkspaceId) || nextState.workspaces[0];
      setWorkspaceNameDraft(current?.name || '');
      setWorkspaceSettingsDraft(normalizeWorkspaceSettings(current?.settings));
      applyWorkspaceLandingView(current?.settings || DEFAULT_WORKSPACE_SETTINGS);
      return nextState;
    }

    setWorkspaceLoading(true);
    try {
      const res = await fetch(`/api/workspaces?username=${encodeURIComponent(username)}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to load workspaces');

      const list = Array.isArray(payload) ? payload : [];
      const candidateId =
        preferredWorkspaceId ||
        (preserveActive ? workspaceState?.activeWorkspaceId || '' : '');
      const hasCandidate = list.some((item) => item.id === candidateId);
      const activeId = hasCandidate ? candidateId : (list[0]?.id || '');
      const nextState = {
        activeWorkspaceId: activeId,
        workspaces: list,
      };
      setWorkspaceState(nextState);
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
      const res = await fetch(`/api/documents/trash?${params.toString()}`);
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
  }, [activeDoc?.id, activeDoc?.content, activeDoc?.contentHtml]);

  useEffect(() => {
    if (!activeDoc?.id || !username || !canCurrentUserManageShareLinks) {
      clearActiveDocShareState();
      return;
    }
    refreshActiveDocShareLinks(activeDoc.id);
  }, [activeDoc?.id, canCurrentUserManageShareLinks, username]);

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
    applyWorkspaceLandingView(activeWorkspace?.settings || DEFAULT_WORKSPACE_SETTINGS);
  }, [activeWorkspaceId]);

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [activeWorkspaceId, showFiles, showAI, docPaneVisible, isLoggedIn]);

  useEffect(() => {
    if (location.state?.showFiles) {
      setShowFiles(true);
      setShowAI(false);
    }
  }, [location.state]);

  useEffect(() => {
    const handleStorage = () => {
      setIsLoggedIn(Boolean(sessionStorage.getItem('username') && sessionStorage.getItem('auth_token')));
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

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
      setShowAI(false);
      setShortcutsOpen(false);
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
    refreshWorkspaces({ preserveActive: false });
    setWorkspaceInviteDraft('');
    setLatestInviteLinks([]);
    setLatestInviteDelivery(null);
    setInviteCopied(false);
    setWorkspaceSettingsOpen(false);
    setWorkspaceInviteOpen(false);
    setAccountManagerOpen(false);
    setTrashModalOpen(false);
  }, [accountName, isLoggedIn, username]);

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
    if (workspaceSettingsOpen) return;
    setWorkspaceNameDraft(activeWorkspace?.name || `${accountName}'s Workspace`);
    setWorkspaceSettingsDraft(activeWorkspaceSettings);
  }, [
    activeWorkspaceId,
    activeWorkspace?.name,
    activeWorkspaceSettings,
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
    };
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setWorkspaceMenuOpen(false);
        setSidebarMenuDocId(null);
        setWorkspaceSettingsOpen(false);
        setWorkspaceInviteOpen(false);
        setAccountManagerOpen(false);
        setTrashModalOpen(false);
        setShortcutsOpen(false);
        setInviteCopied(false);
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
    const extCounts = new Map();
    const tagBag = new Set();
    const categoryBag = new Set();
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let recentUploads = 0;

    documents.forEach((doc) => {
      (doc.tags || []).forEach((tag) => tagBag.add(tag));
      categoryBag.add(normalizeCategory(doc.category));

      const uploadedMs = toTimeMs(doc.uploadedAt);
      if (uploadedMs >= sevenDaysAgo) recentUploads += 1;

      const ext = getDocExt(doc) || 'unknown';
      extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
    });

    const topTypes = Array.from(extCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    return {
      total: Number(documentsTotal) || documents.length,
      categories: categoryBag.size,
      tags: tagBag.size,
      recentUploads,
      topTypes,
    };
  }, [documents, documentsTotal]);
  const recentDocumentActivity = useMemo(
    () =>
      [...documents]
        .sort((a, b) => toTimeMs(b?.uploadedAt) - toTimeMs(a?.uploadedAt))
        .slice(0, 5),
    [documents]
  );
  const recentSummaryActivity = useMemo(
    () =>
      [...summaryHistory]
        .sort((a, b) => toTimeMs(b?.generatedAt) - toTimeMs(a?.generatedAt))
        .slice(0, 4),
    [summaryHistory]
  );
  const overviewPreferenceCards = useMemo(
    () => [
      {
        id: 'landing',
        label: 'Default landing',
        value:
          activeWorkspaceSettings.default_home_tab === 'ai'
            ? 'AI Assistant'
            : activeWorkspaceSettings.default_home_tab === 'files'
              ? 'My Files'
              : 'Home overview',
        detail: `${activeWorkspaceSettings.default_documents_layout} layout · ${activeWorkspaceSettings.default_documents_sort.replace('_', ' ')}`,
      },
      {
        id: 'sidebar',
        label: 'Sidebar',
        value: `${activeWorkspaceSettings.sidebar_density} density`,
        detail: `${activeWorkspaceSettings.show_starred_section ? 'Starred' : 'Starred hidden'} · ${
          activeWorkspaceSettings.show_recent_section ? 'Recent visible' : 'Recent hidden'
        }`,
      },
      {
        id: 'sharing',
        label: 'Sharing policy',
        value:
          activeWorkspaceSettings.link_sharing_mode === 'public'
            ? 'Anyone with link'
            : activeWorkspaceSettings.link_sharing_mode === 'workspace'
              ? 'Workspace members'
              : 'Restricted',
        detail: trustedInviteDomains.length
          ? `${trustedInviteDomains.length} trusted domain${trustedInviteDomains.length > 1 ? 's' : ''}`
          : 'No trusted domains configured',
      },
      {
        id: 'alerts',
        label: 'In-app alerts',
        value: `${enabledWorkspaceNotificationCount}/3 enabled`,
        detail: activeWorkspaceSettings.show_usage_chart
          ? 'Usage chart visible on overview'
          : 'Usage chart hidden on overview',
      },
    ],
    [
      activeWorkspaceSettings.default_documents_layout,
      activeWorkspaceSettings.default_documents_sort,
      activeWorkspaceSettings.default_home_tab,
      activeWorkspaceSettings.link_sharing_mode,
      activeWorkspaceSettings.show_recent_section,
      activeWorkspaceSettings.show_starred_section,
      activeWorkspaceSettings.show_usage_chart,
      activeWorkspaceSettings.sidebar_density,
      enabledWorkspaceNotificationCount,
      trustedInviteDomains.length,
    ]
  );

  useEffect(() => {
    if (hasAdvancedFilters) {
      setAdvancedFiltersOpen(true);
    }
  }, [hasAdvancedFilters]);
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
  const selectedOnCurrentPageCount = useMemo(
    () => visibleDocumentIds.filter((id) => selectedDocumentIdSet.has(id)).length,
    [visibleDocumentIds, selectedDocumentIdSet]
  );
  const selectedOutsideCurrentPageCount = Math.max(0, selectedDocumentCount - selectedOnCurrentPageCount);
  const allDocumentsSelectedOnPage =
    visibleDocumentIds.length > 0 &&
    visibleDocumentIds.every((id) => selectedDocumentIdSet.has(id));
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

  const formatDateTimeLabel = (value) => {
    if (!value) return 'Unknown';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return String(value);
    return dt.toLocaleString();
  };

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
    setInviteCopied(false);
    setLatestInviteLinks([]);
    setLatestInviteDelivery(null);
  };

  const openWorkspaceSettingsPanel = () => {
    setWorkspaceNameDraft(activeWorkspace?.name || `${accountName}'s Workspace`);
    setWorkspaceSettingsDraft(normalizeWorkspaceSettings(activeWorkspace?.settings));
    setWorkspaceSettingsTab('general');
    setWorkspaceSettingsOpen(true);
    setWorkspaceInviteOpen(false);
    setAccountManagerOpen(false);
    setWorkspaceMenuOpen(false);
  };

  const openWorkspaceInvitePanel = () => {
    setWorkspaceInviteOpen(true);
    setWorkspaceSettingsOpen(false);
    setAccountManagerOpen(false);
    setInviteCopied(false);
    setWorkspaceMenuOpen(false);
  };

  const clearActiveDocShareState = () => {
    setActiveDocShareLinks([]);
    setActiveDocShareLinksLoading(false);
    setActiveDocShareLinksError('');
    setActiveDocShareActionLoadingId(0);
    setActiveDocShareActionLoadingType('');
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
    if (settings.default_home_tab === 'files') {
      setShowFiles(true);
      setShowAI(false);
      return;
    }
    if (settings.default_home_tab === 'ai' && settings.allow_ai_tools) {
      setShowFiles(false);
      setShowAI(true);
      return;
    }
    setShowFiles(false);
    setShowAI(false);
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
    setShowAI(false);
    setShortcutsOpen(false);
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
        const res = await fetch('/api/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, name: nextName }),
        });
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
        setLatestInviteLinks([]);
        setLatestInviteDelivery(null);
        setInviteCopied(false);
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
    setLatestInviteLinks([]);
    setLatestInviteDelivery(null);
    setInviteCopied(false);
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
    setLatestInviteLinks([]);
    setLatestInviteDelivery(null);
    setInviteCopied(false);
    applyWorkspaceLandingView(targetWorkspace?.settings || DEFAULT_WORKSPACE_SETTINGS);
  };

  const handleSaveWorkspaceSettings = () => {
    if (!activeWorkspace) return;
    const nextName = workspaceNameDraft.trim();
    if (!nextName) {
      showToast('Workspace name cannot be empty.', 'warning');
      return;
    }
    const nextSettings = normalizeWorkspaceSettings(workspaceSettingsDraft);
    if (isLoggedIn && username) {
      setWorkspaceActionLoading(true);
      fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          name: nextName,
          settings: nextSettings,
        }),
      })
        .then(async (res) => {
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(payload.error || 'Failed to save workspace settings');
          await refreshWorkspaces({ preferredWorkspaceId: activeWorkspace.id });
          applyWorkspaceLandingView(nextSettings);
          setWorkspaceSettingsOpen(false);
          showToast('Workspace settings saved.', 'success');
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
    setWorkspaceSettingsOpen(false);
    showToast('Workspace settings saved.', 'success');
  };

  const buildWorkspaceInviteMessage = (inviteItem = null) => {
    const inviteObject = inviteItem && typeof inviteItem === 'object' ? inviteItem : null;
    const inviteUrl = String(inviteObject?.invite_url || workspaceInviteLink || '').trim();
    if (!inviteUrl) return '';

    const workspaceLabel =
      String(activeWorkspace?.name || `${accountName}'s Workspace`).trim() || 'StudyHub Workspace';
    const inviterLabel =
      String(username || accountName || 'A StudyHub member').trim() || 'A StudyHub member';
    const recipientLabel = String(inviteObject?.email || '').trim();
    const expiryLabel = inviteObject?.expires_at ? formatDateTimeLabel(inviteObject.expires_at) : '';

    return [
      `Subject: Join ${workspaceLabel} on StudyHub`,
      '',
      recipientLabel ? `Hello ${recipientLabel},` : 'Hello,',
      '',
      `${inviterLabel} invited you to join "${workspaceLabel}" on StudyHub.`,
      'Open the invitation link below, sign in with the same invited email address, and request access:',
      inviteUrl,
      expiryLabel ? `This invitation link expires at ${expiryLabel}.` : '',
      'After you request access, the workspace owner still needs to approve it before you can join.',
    ]
      .filter(Boolean)
      .join('\n');
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
    if (activeWorkspaceSettings.restrict_invites_to_domains && trustedInviteDomains.length) {
      const outsideTrustedDomains = candidates.filter(
        (email) => !trustedInviteDomains.includes(getEmailDomain(email))
      );
      if (outsideTrustedDomains.length) {
        showToast(
          `Invite emails must match trusted domains: ${trustedInviteDomains.join(', ')}`,
          'warning'
        );
        return;
      }
    }

    if (isLoggedIn && username) {
      setWorkspaceActionLoading(true);
      try {
        const res = await fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/invitations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            emails: candidates,
            expiry_days: activeWorkspaceSettings.default_invite_expiry_days,
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || 'Failed to create invitations');

        const createdItems = Array.isArray(payload.created) ? payload.created.filter(Boolean) : [];
        const links = createdItems.map((item) => item?.invite_url).filter(Boolean);
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

        setLatestInviteLinks(links);
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
        setInviteCopied(false);
        await refreshWorkspaces({ preferredWorkspaceId: activeWorkspace.id });

        if (failedItems.length) {
          const createdCount = createdItems.length || candidates.length;
          if (sentCount > 0) {
            showToast(
              `Created ${createdCount} invite(s). ${sentCount} email(s) were sent, and ${failedItems.length} need manual sharing.`,
              'warning'
            );
          } else {
            showToast(
              `Created ${createdCount} invite(s), but emails were not sent automatically. Use Copy Invite Message.`,
              'warning'
            );
          }
        } else if (links.length || candidates.length) {
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
    setLatestInviteLinks([]);
    setLatestInviteDelivery({
      type: 'local',
      createdCount: candidates.length,
      emailSentCount: 0,
      emailFailedCount: 0,
      failedItems: [],
      invalidEmails: [],
      manualShareRecommended: true,
    });
    setInviteCopied(false);
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
        const res = await fetch(
          `/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/invitations/${targetInvitationId}`,
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username }),
          }
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

  const handleReviewInvitation = async (inviteItem, action) => {
    if (!activeWorkspace || !isLoggedIn || !username) return;
    const invitationId = Number(inviteItem?.id);
    if (!Number.isFinite(invitationId) || invitationId <= 0) return;
    if (!['approve', 'reject'].includes(action)) return;

    setWorkspaceActionLoading(true);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/invitations/${invitationId}/review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            action,
          }),
        }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Review failed');
      await refreshWorkspaces({ preferredWorkspaceId: activeWorkspace.id });
    } catch (err) {
      showToast(err.message || 'Review failed', 'error');
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
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(activeWorkspace.id)}/invitations/${invitationId}/resend`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username }),
        }
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

      if (payload?.invite_url) {
        setLatestInviteLinks([payload.invite_url]);
      }
      setLatestInviteDelivery({
        type: 'resend',
        createdCount: 1,
        emailSentCount: emailSent ? 1 : 0,
        emailFailedCount: emailSent ? 0 : 1,
        failedItems,
        invalidEmails: [],
        manualShareRecommended: !emailSent,
      });
      setInviteCopied(false);
      await refreshWorkspaces({ preferredWorkspaceId: activeWorkspace.id });

      if (emailSent) {
        showWorkspaceToast('sharing', `Resent invitation email to ${targetEmail || 'recipient'}.`, 'success');
      } else {
        showToast('Invitation refreshed, but email was not sent automatically. Use Copy Invite Message.', 'warning');
      }
    } catch (err) {
      showToast(err.message || 'Failed to resend invitation email', 'error');
    } finally {
      setWorkspaceActionLoading(false);
    }
  };

  const handleCopyInviteLink = async (inviteItem = null) => {
    const inviteUrl =
      typeof inviteItem === 'object' && inviteItem
        ? String(inviteItem?.invite_url || '').trim()
        : String(workspaceInviteLink || '').trim();
    if (!inviteUrl) {
      showToast('There is no invitation link to copy.', 'warning');
      return;
    }
    try {
      await navigator.clipboard.writeText(inviteUrl);
      if (!inviteItem) setInviteCopied(true);
      showWorkspaceToast('sharing', 'Invite link copied.', 'success');
    } catch {
      showToast('Copy failed. Please copy the link manually.', 'error');
    }
  };

  const handleCopyInviteMessage = async (inviteItem = null) => {
    const message = buildWorkspaceInviteMessage(inviteItem);
    if (!message) {
      showToast('There is no invitation message to copy yet.', 'warning');
      return;
    }
    try {
      await navigator.clipboard.writeText(message);
      showWorkspaceToast('sharing', 'Invite message copied.', 'success');
    } catch {
      showToast('Copy failed. Please copy the message manually.', 'error');
    }
  };

  const handleSaveManualAccount = () => {
    const draft = normalizeAccountRecord(accountDraft);
    const target = draft;
    if (!target) {
      showToast('Please enter an account name.', 'warning');
      return;
    }
    if (target.email && !EMAIL_REGEX.test(target.email)) {
      showToast('Invalid email format.', 'warning');
      return;
    }
    setSavedAccounts((prev) => upsertAccount(prev, target));
    setAccountDraft({ username: '', email: '' });
    handleSwitchAccount(target);
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

  const buildAuthenticatedJsonHeaders = () => {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    return headers;
  };

  const handleExtractText = async (imageFile) => {
    if (!imageFile) {
      showToast('Please select an image first.', 'warning');
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
      const response = await fetch('/api/extract-text', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const runtimeHints = Array.isArray(data?.details?.runtime?.hints)
          ? data.details.runtime.hints.join(' | ')
          : '';
        const detail = [
          data?.error,
          data?.details?.external,
          data?.details?.huggingface,
          data?.details?.local,
          runtimeHints,
        ]
          .filter(Boolean)
          .join(' | ');
        showToast(`Text extraction failed: ${detail || 'Service error'}`, 'error');
        return;
      }

      const nextText = coerceOcrText(data?.text ?? data);
      setAiHideInputText(false);
      setExtractedText(nextText);
      setAnalysisResult(null);
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

  const handleAIImageChange = async (event) => {
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    if (!file) return;
    if (!activeWorkspaceSettings.allow_ai_tools || !activeWorkspaceSettings.allow_ocr) return;
    await handleExtractText(file);
  };

  const openAIImagePicker = () => {
    if (!activeWorkspaceSettings.allow_ai_tools || !activeWorkspaceSettings.allow_ocr) return;
    if (isExtracting) return;
    aiImageInputRef.current?.click();
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
      const response = await fetch('/api/analyze-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data?.error || 'Service error');
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

    setAiHideInputText(false);
    const data = await requestSummary({
      text: extractedText,
      forceRefresh,
      docTitle: forceRefresh ? 'Manual text' : '',
    });
    if (!data) return;
    setAnalysisResult(data);
    const docId = toPositiveDocId(data?.document_id);
    const sourceDoc = docId ? documents.find((item) => toPositiveDocId(item.id) === docId) : null;
    const historyEntry = toSummaryHistoryEntry(sourceDoc || activeDoc || { id: docId }, data, {
      docId,
      title: sourceDoc?.title || activeDoc?.title || (docId ? `Note ${docId}` : 'Manual Text'),
      fileType: sourceDoc ? getDocExt(sourceDoc) : '',
    });
    if (historyEntry) {
      pushSummaryHistoryEntry(historyEntry);
    }
    if (data.cache_hit) {
      showWorkspaceToast('summary', 'Loaded summary from cache.', 'success');
    } else if (forceRefresh) {
      showWorkspaceToast('summary', 'Summary regenerated.', 'success');
    }
  };

  const toSummaryExportText = () => {
    if (!analysisResult) return '';
    const keywords = Array.isArray(analysisResult.keywords) ? analysisResult.keywords : [];
    const keySentences = Array.isArray(analysisResult.key_sentences)
      ? analysisResult.key_sentences
      : [];
    const blocks = [
      `Summary:\n${analysisResult.summary || ''}`,
      `Keywords:\n${keywords.length ? keywords.join(', ') : 'N/A'}`,
      `Key Sentences:\n${keySentences.length ? keySentences.join('\n') : 'N/A'}`,
      `Source:\n${analysisResult.summary_source || 'fallback'}`,
    ];
    if (analysisResult.summary_note) {
      blocks.push(`Note:\n${analysisResult.summary_note}`);
    }
    return blocks.join('\n\n').trim();
  };

  const downloadTextFile = (filename, content) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleCopySummary = async () => {
    if (!activeWorkspaceSettings.allow_export) {
      showToast('Export is disabled in this workspace settings.', 'warning');
      return;
    }
    const output = toSummaryExportText();
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
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
    const output = toSummaryExportText();
    if (!output) return;
    const stamp = new Date().toISOString().slice(0, 10);
    downloadTextFile(`studyhub-summary-${stamp}.txt`, output);
  };

  const handleEmailSummary = () => {
    if (!activeWorkspaceSettings.allow_export) {
      showToast('Export is disabled in this workspace settings.', 'warning');
      return;
    }
    const output = toSummaryExportText();
    if (!output) return;
    const subject = encodeURIComponent('StudyHub Note Summary');
    const body = encodeURIComponent(output.slice(0, 7000));
    window.open(`mailto:?subject=${subject}&body=${body}`, '_blank', 'noopener,noreferrer');
  };

  const handleOpenSummaryCenter = () => {
    setSummaryCenterActionId('');
    setSummaryCenterOpen(true);
  };

  const handleApplySummaryHistoryItem = (item) => {
    const entry = normalizeSummaryHistoryEntry(item);
    if (!entry) return;
    setAnalysisResult({
      summary: entry.summary,
      keywords: entry.keywords,
      key_sentences: entry.keySentences,
      summary_source: entry.summarySource,
      summary_note: entry.summaryNote,
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
    });
    setAiHideInputText(true);
    setExtractedText('');
    setShowFiles(false);
    setShowAI(true);
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

  const handleExportSummaryHistoryTxt = () => {
    if (!summaryHistoryItems.length) {
      showToast('No summary items to export.', 'warning');
      return;
    }
    const content = summaryHistoryItems
      .map((entry, index) => {
        const keywords = Array.isArray(entry.keywords) ? entry.keywords.join(', ') : '';
        const keySentences = Array.isArray(entry.keySentences) ? entry.keySentences.join('\n') : '';
        return [
          `#${index + 1} ${entry.title}`,
          `Date: ${formatDateTimeLabel(entry.generatedAt)}`,
          `Source: ${getSummarySourceLabel(entry.summarySource)}`,
          `Type: ${(entry.fileType || 'text').toUpperCase()}`,
          '',
          'Summary:',
          entry.summary || 'N/A',
          '',
          'Keywords:',
          keywords || 'N/A',
          '',
          'Key Sentences:',
          keySentences || 'N/A',
        ].join('\n');
      })
      .join('\n\n----------------------------------------\n\n');
    const stamp = new Date().toISOString().slice(0, 10);
    downloadTextFile(`studyhub-summary-history-${stamp}.txt`, content);
    showWorkspaceToast('summary', 'Summary history exported as TXT.', 'success');
  };

  const handleExportSummaryHistoryJson = () => {
    if (!summaryHistoryItems.length) {
      showToast('No summary items to export.', 'warning');
      return;
    }
    const payload = summaryHistoryItems.map((entry) => ({
      id: entry.id,
      document_id: toPositiveDocId(entry.docId) || null,
      title: entry.title,
      file_type: entry.fileType || '',
      summary: entry.summary,
      keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
      key_sentences: Array.isArray(entry.keySentences) ? entry.keySentences : [],
      summary_source: normalizeSummarySource(entry.summarySource),
      summary_note: entry.summaryNote || '',
      summary_length: entry.summaryLength || '',
      chunk_count: entry.chunkCount || 1,
      merge_rounds: entry.mergeRounds || 0,
      refreshed_from_file: Boolean(entry.refreshedFromFile),
      pdf_extractor: entry.pdfExtractor || '',
      pdf_ocr_used: Boolean(entry.pdfOcrUsed),
      text_word_count: entry.textWordCount || 0,
      text_char_count: entry.textCharCount || 0,
      summarizer_model: entry.summarizerModel || '',
      generated_at: entry.generatedAt || '',
    }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `studyhub-summary-history-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showWorkspaceToast('summary', 'Summary history exported as JSON.', 'success');
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
      showWorkspaceToast('summary', 'Summary rebuilt successfully.', 'success');
    } finally {
      stopSummaryProgress(progressToken);
      setSummaryCenterActionId('');
    }
  };

  const handleUseDocumentForAI = async (doc, options = {}) => {
    const forceRefresh = Boolean(options?.forceRefresh);
    if (!activeWorkspaceSettings.allow_ai_tools) {
      showToast('AI tools are disabled in this workspace settings.', 'warning');
      return;
    }
    const text = String(doc?.content || '').trim();
    const docId = Number(doc?.id) || 0;
    if (!text && docId <= 0) {
      showToast('This note has no extracted text yet.', 'warning');
      return;
    }
    closeDocumentPane();
    setAiHideInputText(true);
    setExtractedText('');
    setAnalysisResult(null);
    setShowFiles(false);
    setShowAI(true);
    window.requestAnimationFrame(() => {
      document.getElementById('ai-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const result = await requestSummary({
      text: docId > 0 ? '' : text,
      docId,
      docTitle: String(doc?.title || '').trim(),
      forceRefresh,
    });
    if (!result) return;
    setAnalysisResult(result);
    const historyEntry = toSummaryHistoryEntry(doc, result, { docId });
    if (historyEntry) {
      pushSummaryHistoryEntry(historyEntry);
    }
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
    if (!Number.isFinite(targetDocId) || targetDocId <= 0 || !username || !canCurrentUserManageShareLinks) {
      clearActiveDocShareState();
      return;
    }
    setActiveDocShareLinksLoading(true);
    setActiveDocShareLinksError('');
    try {
      const params = new URLSearchParams({ username });
      const res = await fetch(`/api/documents/${targetDocId}/share-links?${params.toString()}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to load share links');
      const items = Array.isArray(payload.items) ? payload.items : [];
      setActiveDocShareLinks(items);
    } catch (err) {
      setActiveDocShareLinks([]);
      setActiveDocShareLinksError(err.message || 'Failed to load share links');
    } finally {
      setActiveDocShareLinksLoading(false);
    }
  };

  const handleRevokeActiveDocShareLink = async (shareLink) => {
    if (!activeDoc || !username || !canCurrentUserManageShareLinks) return;
    const shareLinkId = Number(shareLink?.id);
    if (!Number.isFinite(shareLinkId) || shareLinkId <= 0) return;
    setActiveDocShareActionLoadingId(shareLinkId);
    setActiveDocShareActionLoadingType('revoke');
    try {
      const res = await fetch(`/api/documents/${activeDoc.id}/share-links/${shareLinkId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to revoke share link');
      await refreshActiveDocShareLinks(activeDoc.id);
    } catch (err) {
      showToast(err.message || 'Failed to revoke share link', 'error');
    } finally {
      setActiveDocShareActionLoadingId(0);
      setActiveDocShareActionLoadingType('');
    }
  };

  const handleDeleteActiveDocShareLink = async (shareLink) => {
    if (!activeDoc || !username || !canCurrentUserManageShareLinks) return;
    const shareLinkId = Number(shareLink?.id);
    if (!Number.isFinite(shareLinkId) || shareLinkId <= 0) return;
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
      const res = await fetch(`/api/documents/${activeDoc.id}/share-links/${shareLinkId}/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to delete share link');
      await refreshActiveDocShareLinks(activeDoc.id);
      showWorkspaceToast('sharing', 'Share link deleted.', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to delete share link', 'error');
    } finally {
      setActiveDocShareActionLoadingId(0);
      setActiveDocShareActionLoadingType('');
    }
  };

  const handleDeleteInactiveActiveDocShareLinks = async () => {
    if (!activeDoc || !username || !canCurrentUserManageShareLinks) return;
    const shouldDelete = await requestConfirmation({
      title: 'Delete all inactive share links?',
      description: 'This permanently removes all expired and revoked share links from the list.',
      confirmLabel: 'Delete All Inactive',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!shouldDelete) return;

    setActiveDocShareActionLoadingId(-2);
    setActiveDocShareActionLoadingType('delete-inactive');
    try {
      const res = await fetch(`/api/documents/${activeDoc.id}/share-links/inactive`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to delete inactive share links');
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
    if (!activeDoc || !username || !canCurrentUserManageShareLinks) return;
    const shouldRevokeAll = await requestConfirmation({
      title: 'Revoke all share links?',
      description: 'All active links of this document will be revoked immediately.',
      confirmLabel: 'Revoke All',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!shouldRevokeAll) return;
    setActiveDocShareActionLoadingId(-1);
    setActiveDocShareActionLoadingType('revoke-all');
    try {
      const res = await fetch(`/api/documents/${activeDoc.id}/share-links`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to revoke all share links');
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
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showWorkspaceToast('sharing', 'Share link copied.', 'success');
    } catch {
      showToast('Copy failed. Please copy manually.', 'error');
    }
  };

  const handleShareDocument = async (doc) => {
    if (activeWorkspaceSettings.link_sharing_mode === 'restricted') {
      showToast('Link sharing is restricted. Change this in Workspace Settings.', 'warning');
      return;
    }
    if (!canCurrentUserManageShareLinks) {
      showToast('Only workspace owner can create share links in current settings.', 'warning');
      return;
    }
    if (!username) {
      showToast('Please sign in to create a share link.', 'warning');
      return;
    }
    const docId = Number(doc?.id);
    if (!Number.isFinite(docId)) return;
    try {
      const res = await fetch(`/api/documents/${docId}/share-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          expiry_days: activeWorkspaceSettings.default_share_expiry_days,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const activeCount = Number(payload?.active_count);
        const maxCount = Number(payload?.max_active_share_links_per_document);
        if (res.status === 409 && Number.isFinite(activeCount) && Number.isFinite(maxCount)) {
          throw new Error(
            `Share link limit reached (${activeCount}/${maxCount}). Revoke old links or enable auto-revoke.`
          );
        }
        throw new Error(payload.error || 'Failed to create share link');
      }
      const shareUrl = payload.token
        ? `${window.location.origin}/#/shared/${payload.token}`
        : payload.share_url || '';
      if (!shareUrl.trim()) throw new Error('Failed to create share link');

      await navigator.clipboard.writeText(shareUrl);
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
      const res = await fetch(`/api/workspaces/${encodeURIComponent(activeWorkspaceId)}/documents`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
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

  const handleDeleteWorkspace = async () => {
    if (!activeWorkspaceId || !username || !isLoggedIn) {
      showToast('Please sign in first.', 'warning');
      return;
    }
    if (activeWorkspace?.is_owner === false) {
      showToast('Only the workspace owner can delete this workspace.', 'warning');
      return;
    }

    const workspaceLabel = String(activeWorkspace?.name || '').trim();
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
      const res = await fetch(`/api/workspaces/${encodeURIComponent(activeWorkspaceId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to delete workspace');

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
      closeWorkspaceDialogs();

      const nextWorkspaceState = await refreshWorkspaces({ preserveActive: false });
      const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
      if (warnings.length) {
        showToast(
          `Deleted workspace "${workspaceLabel}". Some files could not be removed from storage.`,
          'warning'
        );
      } else {
        const nextWorkspace =
          (nextWorkspaceState?.workspaces || []).find(
            (item) => item.id === nextWorkspaceState?.activeWorkspaceId
          ) ||
          nextWorkspaceState?.workspaces?.[0] ||
          null;
        const followup = nextWorkspace?.name ? ` Switched to "${nextWorkspace.name}".` : '';
        showToast(`Deleted workspace "${workspaceLabel}".${followup}`, 'success');
      }
    } catch (err) {
      showToast(err.message || 'Failed to delete workspace', 'error');
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
    setSidebarMenuDocId(null);
    setActiveDoc(null);
    clearActiveDocShareState();

    if (fromSidebar) {
      // Sidebar click should open the document pane directly, not stay in file-list mode.
      setShowFiles(false);
      setShowAI(false);
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
      const res = await fetch(endpoint);
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
        const res = await fetch(`/api/documents?${params.toString()}`);
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
          const res = await fetch(`/api/documents/${docId}/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username || '' }),
          });
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
          const res = await fetch(`/api/documents/${docId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username || '', permanent: true }),
          });
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
      const res = await fetch(`/api/documents/${docId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username || '' }),
      });
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
      const res = await fetch(`/api/documents/${docId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username || '', permanent: true }),
      });
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
      const res = await fetch(`/api/documents/${doc.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username || '' }),
      });
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
        const res = await fetch(`/api/documents/${docId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username || '' }),
        });
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
        const res = await fetch(`/api/documents/${docId}/category`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: nextCategory, username: username || '' }),
        });
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
        const res = await fetch(`/api/documents/${docId}/tags`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: nextTags, username: username || '' }),
        });
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
      const res = await fetch(`/api/documents/${doc.id}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: nextTags, username: username || '' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update tags');

      const normalized = normalizeDocument(data);
      setDocuments((prev) => prev.map((item) => (item.id === doc.id ? normalized : item)));
      setActiveDoc((prev) => (prev?.id === doc.id ? normalized : prev));
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
      const res = await fetch(`/api/documents/${doc.id}/category`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: nextCategory, username: username || '' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update category');

      const normalized = normalizeDocument(data);
      setDocuments((prev) => prev.map((item) => (item.id === doc.id ? normalized : item)));
      setActiveDoc((prev) => (prev?.id === doc.id ? normalized : prev));
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
      const res = await fetch(`/api/documents/${activeDoc.id}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: contentText,
          content_html: contentHtml,
          username: username || '',
        }),
      });
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
      const res = await fetch(`/api/documents/${activeDoc.id}/pdf${query}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: payload,
      });
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

  const buildQuickFilterPreset = (presetId) => {
    const safeId = String(presetId || '').trim().toLowerCase();
    if (safeId === 'recent7') {
      const range = getQuickDateRange(6);
      return {
        ...DEFAULT_FILTERS,
        start: range.start,
        end: range.end,
      };
    }
    if (safeId === 'images') {
      return {
        ...DEFAULT_FILTERS,
        fileType: 'image',
      };
    }
    if (safeId === 'editable') {
      return {
        ...DEFAULT_FILTERS,
        fileType: 'editable',
      };
    }
    if (safeId === 'uncategorized') {
      return {
        ...DEFAULT_FILTERS,
        category: DEFAULT_NOTE_CATEGORY,
      };
    }
    return { ...DEFAULT_FILTERS };
  };

  const applyQuickFilterPreset = (presetId) => {
    const safeId = String(presetId || '').trim().toLowerCase();
    if (!safeId) return;
    const target = buildQuickFilterPreset(safeId);
    const isActive = activeQuickFilterPresetId === safeId;
    setSelectedDocumentIds([]);
    setDocumentsPage(1);
    if (isActive) {
      setFilters({ ...DEFAULT_FILTERS });
      setSearchDraft('');
      return;
    }
    setFilters(target);
    setSearchDraft(target.query || '');
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
    const qs = params.toString();
    return `/api/documents/${activeDoc.id}/file${qs ? `?${qs}` : ''}`;
  }, [activeDoc, activeDocFileVersion, username]);
  const activeDocStreamUrl = activeDocFileUrl;
  const activeDocExt = activeDoc ? getDocExt(activeDoc) : '';
  const activeDocIsImage = ['jpg', 'jpeg', 'png', 'webp'].includes(activeDocExt);
  const activeDocIsPdf = activeDocExt === 'pdf';
  const activeDocCanEditText = ['txt', 'docx'].includes(activeDocExt);
  const activeDocViewHtml = useMemo(() => getDocumentRichHtml(activeDoc), [activeDoc]);
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
    clearActiveDocShareState();
  };

  const openFilesAndFocusSearch = () => {
    if (docPaneVisible) closeDocumentPane();
    setShowFiles(true);
    setShowAI(false);
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
      setShowAI(false);
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

  useEffect(() => {
    const handleShortcuts = (event) => {
      const key = String(event.key || '').toLowerCase();
      const withModifier = event.metaKey || event.ctrlKey;
      const typing = isTypingTarget(event.target);
      const blockingModalOpen =
        inputDialogState.open ||
        confirmDialogState.open ||
        workspaceSettingsOpen ||
        workspaceInviteOpen ||
        accountManagerOpen ||
        trashModalOpen ||
        shortcutsOpen;

      if (blockingModalOpen && key !== 'escape') return;
      if (typing && !(withModifier && key === 'k')) return;

      if (withModifier && key === 'k') {
        event.preventDefault();
        openFilesAndFocusSearch();
        return;
      }
      if (withModifier && event.shiftKey && key === 'u') {
        if (!activeWorkspaceSettings.allow_uploads) return;
        event.preventDefault();
        setShowFiles(true);
        setShowAI(false);
        fileInputRef.current?.click();
        return;
      }
      if (withModifier && event.shiftKey && key === 's') {
        event.preventDefault();
        void handleSaveCurrentView();
        return;
      }
      if (!withModifier && key === '/' && !typing) {
        event.preventDefault();
        openFilesAndFocusSearch();
        return;
      }
      if (!withModifier && key === '?' && !typing) {
        event.preventDefault();
        setShortcutsOpen(true);
      }
    };

    document.addEventListener('keydown', handleShortcuts);
    return () => document.removeEventListener('keydown', handleShortcuts);
  }, [
    activeWorkspaceSettings.allow_uploads,
    handleSaveCurrentView,
    openFilesAndFocusSearch,
    inputDialogState.open,
    confirmDialogState.open,
    workspaceSettingsOpen,
    workspaceInviteOpen,
    accountManagerOpen,
    trashModalOpen,
    shortcutsOpen,
  ]);

  return (
    <div
      className={`notion-shell ${sidebarDensityClass}${mobileSidebarOpen ? ' is-mobile-sidebar-open' : ''}`.trim()}
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
          !workspaceLoading &&
          !workspaceActionLoading &&
          !(isLoggedIn && activeWorkspace?.is_owner === false)
        }
        onOpenWorkspaceInvite={() => {
          setMobileSidebarOpen(false);
          openWorkspaceInvitePanel();
        }}
        canOpenWorkspaceInvite={
          Boolean(activeWorkspace) &&
          !workspaceLoading &&
          !workspaceActionLoading &&
          !(
            isLoggedIn &&
            activeWorkspace?.is_owner === false &&
            !activeWorkspaceSettings.allow_member_invites
          )
        }
        accountEmail={accountEmail}
        onOpenAccountManager={() => {
          setMobileSidebarOpen(false);
          setAccountManagerOpen(true);
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
        workspaceInviteOpen={workspaceInviteOpen}
        workspaceInviteDraft={workspaceInviteDraft}
        onChangeWorkspaceInviteDraft={setWorkspaceInviteDraft}
        workspaceActionLoading={workspaceActionLoading}
        onInviteMembers={handleInviteMembers}
        inviteCopied={inviteCopied}
        onCopyInviteLink={handleCopyInviteLink}
        onCopyInviteMessage={handleCopyInviteMessage}
        workspaceInviteLink={workspaceInviteLink}
        latestInviteDelivery={latestInviteDelivery}
        trustedInviteDomains={trustedInviteDomains}
        defaultInviteExpiryDays={activeWorkspaceSettings.default_invite_expiry_days}
        inviteItems={inviteItems}
        onResendInvitation={handleResendInvitation}
        onReviewInvitation={handleReviewInvitation}
        onRemoveInvite={handleRemoveInvite}
        homeActive={!showFiles && !showAI && !docPaneVisible}
        filesActive={showFiles && !showAI && !docPaneVisible}
        aiActive={showAI && !docPaneVisible}
        aiDisabled={!activeWorkspaceSettings.allow_ai_tools}
        onGoHome={() => {
          setMobileSidebarOpen(false);
          closeDocumentPane();
          setShowFiles(false);
          setShowAI(false);
        }}
        onGoFiles={() => {
          setMobileSidebarOpen(false);
          closeDocumentPane();
          setShowFiles(true);
          setShowAI(false);
        }}
        onGoAI={() => {
          if (!activeWorkspaceSettings.allow_ai_tools) return;
          setMobileSidebarOpen(false);
          closeDocumentPane();
          setShowFiles(false);
          setShowAI(true);
          setAiHideInputText(false);
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
        sidebarMenuDocId={sidebarMenuDocId}
        onToggleSidebarMenu={(docId) =>
          setSidebarMenuDocId((prev) => (prev === docId ? null : docId))
        }
        onOpenRecentDocument={(doc) => {
          setMobileSidebarOpen(false);
          openDocumentInPane(doc.id, { fromSidebar: true, seedDoc: doc });
        }}
        username={username}
      />

      <div className="notion-main">
        <header className="notion-topbar" role="banner">
          <div className="notion-top-left">
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
            <span className="notion-top-pill">{Number(documentsTotal) || 0} Notes</span>
            <span className="notion-top-pill">{dashboardStats.tags} Tags</span>
            <span className="notion-top-pill">{starredNotes.length} Starred</span>
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
              Summary Center ({summaryHistory.length})
            </button>
            <button
              type="button"
              className="notion-more-btn"
              aria-label="Open shortcuts"
              onClick={() => setShortcutsOpen(true)}
            >
              ⋯
            </button>
          </div>
        </header>

        <main id="main" className="notion-content" role="main">
          {!isLoggedIn && (
            <div id="login-warning" className="notion-warning" role="alert">
              You are not signed in yet. Uploading, viewing, summarizing, deleting, and tag editing require sign-in.
            </div>
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
                <article className="document-detail-card">
                  {showOuterDocHeader && (
                    <header className="notion-inline-doc-head">
                      <div>
                        <h2>{activeDoc.title}</h2>
                        <div className="document-meta">
                          Uploaded: {activeDoc.uploadedAt ? new Date(activeDoc.uploadedAt).toLocaleString() : ''}
                        </div>
                        <div className="document-meta">Category: {normalizeCategory(activeDoc.category)}</div>
                        <div className="document-meta">
                          Tags: {activeDoc.tags?.length ? activeDoc.tags.join(', ') : 'None'}
                        </div>
                      </div>
                      <div className="notion-inline-doc-actions">
                        <a
                          href={activeDocFileUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="btn"
                        >
                          Download File
                        </a>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => handleUseDocumentForAI(activeDoc)}
                          disabled={!activeWorkspaceSettings.allow_ai_tools}
                        >
                          Summarize Document
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => handleRegenerateDocumentSummary(activeDoc)}
                          disabled={!activeWorkspaceSettings.allow_ai_tools}
                          title={
                            activeWorkspaceSettings.allow_ai_tools
                              ? 'Bypass cache and refresh document text before summarizing'
                              : 'AI is disabled in workspace settings'
                          }
                        >
                          Rebuild (Refresh Text)
                        </button>
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
                          onClick={() => handleShareDocument(activeDoc)}
                          disabled={
                            activeWorkspaceSettings.link_sharing_mode === 'restricted' ||
                            !username ||
                            !canCurrentUserManageShareLinks
                          }
                        >
                          Share Link
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

                  {username && canCurrentUserManageShareLinks && (
                    <section className="notion-doc-share-manager" aria-label="Document share links">
                      <div className="notion-doc-share-manager-head">
                        <h3>Share Links</h3>
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
                            onClick={() => refreshActiveDocShareLinks(activeDoc.id)}
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
                        <p className="muted tiny">No share links yet. Click "Share Link" to create one.</p>
                      )}
                      {activeDocShareLinks.length > 0 && (
                        <ul className="notion-doc-share-list">
                          {activeDocShareLinks.map((item, index) => {
                            const status = String(item?.status || 'unknown').toLowerCase();
                            const isActive = isActiveShareLink(item);
                            const loading = Number(item?.id) === activeDocShareActionLoadingId;
                            return (
                              <li key={`doc-share-${item?.id || item?.token || index}`}>
                                <a href={item?.share_url || '#'} target="_blank" rel="noreferrer">
                                  {item?.share_url || 'Invalid link'}
                                </a>
                                <span className="notion-doc-share-meta">
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
                  )}
                  {username && !canCurrentUserManageShareLinks && (
                    <p className="muted tiny">
                      Share link management is owner-only in current workspace settings.
                    </p>
                  )}

                  <section
                    className={`document-body notion-inline-doc-body${activeDocIsPdf ? ' notion-inline-doc-body-pdf' : ''}`}
                  >
                    {activeDocCanEditText && activeDocEditMode ? (
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
                        dangerouslySetInnerHTML={{ __html: activeDocViewHtml || '<p><br></p>' }}
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
                          downloadUrl={activeDocFileUrl}
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

          {!showFiles && !showAI && !docPaneVisible && (
            <section className="notion-overview-hero" aria-label="Workspace overview">
              <div className="notion-overview-hero-main">
                <div className="notion-overview-eyebrow">
                  <span className="notion-avatar notion-avatar-large" aria-hidden="true">
                    {workspaceIconLabel(activeWorkspace, accountName)}
                  </span>
                  <span>{isLoggedIn ? 'Workspace overview' : 'Guest workspace'}</span>
                </div>
                <h2>{activeWorkspace?.name || `${accountName}'s Workspace`}</h2>
                <p>
                  {activeWorkspaceSettings.description ||
                    'Keep lecture files, summaries, and collaboration rules in one workspace that feels closer to modern study tools.'}
                </p>
                <div className="notion-overview-chip-row" aria-label="Workspace highlights">
                  <span className="notion-summary-chip">Notes {dashboardStats.total}</span>
                  <span className="notion-summary-chip">Members {workspaceMemberCount || 1}</span>
                  <span className="notion-summary-chip">
                    Share {activeWorkspaceSettings.link_sharing_mode}
                  </span>
                  <span className="notion-summary-chip">
                    Alerts {enabledWorkspaceNotificationCount}/3
                  </span>
                </div>
                <div className="notion-overview-hero-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      closeDocumentPane();
                      setShowFiles(true);
                      setShowAI(false);
                    }}
                  >
                    Open Files
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (!activeWorkspaceSettings.allow_ai_tools) return;
                      closeDocumentPane();
                      setShowFiles(false);
                      setShowAI(true);
                      setAiHideInputText(false);
                    }}
                    disabled={!activeWorkspaceSettings.allow_ai_tools}
                  >
                    Ask AI
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={handleOpenSummaryCenter}
                    disabled={!activeWorkspaceSettings.allow_ai_tools}
                  >
                    Summary Center
                  </button>
                </div>
              </div>
              {activeWorkspaceSettings.show_quick_actions && (
                <aside className="notion-overview-command-panel" aria-label="Quick actions">
                  <div className="notion-overview-command-head">
                    <h3>Quick actions</h3>
                    <span>{nowLabel}</span>
                  </div>
                  <div className="notion-overview-command-list">
                    <button
                      type="button"
                      className="notion-overview-command-btn"
                      onClick={() => {
                        closeDocumentPane();
                        setShowFiles(true);
                        setShowAI(false);
                        window.requestAnimationFrame(() => {
                          fileInputRef.current?.click();
                        });
                      }}
                      disabled={!activeWorkspaceSettings.allow_uploads}
                    >
                      <strong>Upload note</strong>
                      <span>Jump into Files and open the picker immediately.</span>
                    </button>
                    <button
                      type="button"
                      className="notion-overview-command-btn"
                      onClick={openWorkspaceSettingsPanel}
                      disabled={
                        !activeWorkspace ||
                        workspaceLoading ||
                        workspaceActionLoading ||
                        (isLoggedIn && activeWorkspace?.is_owner === false)
                      }
                    >
                      <strong>Workspace settings</strong>
                      <span>Adjust defaults, layout, sharing, and notifications.</span>
                    </button>
                    <button
                      type="button"
                      className="notion-overview-command-btn"
                      onClick={openWorkspaceInvitePanel}
                      disabled={
                        !activeWorkspace ||
                        workspaceLoading ||
                        workspaceActionLoading ||
                        (isLoggedIn &&
                          activeWorkspace?.is_owner === false &&
                          !activeWorkspaceSettings.allow_member_invites)
                      }
                    >
                      <strong>Invite members</strong>
                      <span>
                        {trustedInviteDomains.length
                          ? `Restricted to ${trustedInviteDomains.join(', ')}`
                          : 'Share collaboration access with your study group.'}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="notion-overview-command-btn"
                      onClick={() => {
                        if (!activeWorkspaceSettings.allow_ai_tools) return;
                        setShowFiles(false);
                        setShowAI(true);
                        setAiHideInputText(false);
                        setExtractedText('');
                      }}
                      disabled={!activeWorkspaceSettings.allow_ai_tools}
                    >
                      <strong>Start AI session</strong>
                      <span>Paste text, summarize documents, or extract from images.</span>
                    </button>
                  </div>
                </aside>
              )}
            </section>
          )}

          {!showFiles && !showAI && !docPaneVisible && (
            <section className="notion-dashboard-grid" aria-label="Dashboard summary">
              <article className="notion-dashboard-card">
                <h3>Total Notes</h3>
                <strong>{dashboardStats.total}</strong>
                <span>All uploaded lecture files</span>
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
              <article className="notion-dashboard-card notion-dashboard-card-wide">
                <h3>File Type Mix</h3>
                <strong>
                  {dashboardStats.topTypes.length
                    ? dashboardStats.topTypes.map(([ext, count]) => `${ext.toUpperCase()}: ${count}`).join(' · ')
                    : 'No data yet'}
                </strong>
                <span>Distribution of your note formats</span>
              </article>
              {overviewPreferenceCards.map((item) => (
                <article key={item.id} className="notion-dashboard-card">
                  <h3>{item.label}</h3>
                  <strong>{item.value}</strong>
                  <span>{item.detail}</span>
                </article>
              ))}
            </section>
          )}

          {!showFiles && !showAI && !docPaneVisible && activeWorkspaceSettings.show_recent_activity && (
            <section className="notion-overview-activity-grid" aria-label="Recent activity">
              <article className="notion-panel-block notion-overview-activity-panel">
                <div className="notion-panel-head">
                  <h2 className="section-title">Recent uploads</h2>
                  <p>Quickly reopen the latest notes added to this workspace.</p>
                </div>
                {recentDocumentActivity.length ? (
                  <ul className="notion-overview-activity-list">
                    {recentDocumentActivity.map((doc) => (
                      <li key={`overview-doc-${doc.id}`}>
                        <button
                          type="button"
                          className="notion-overview-activity-item"
                          onClick={() => openDocumentInPane(doc.id, { fromSidebar: true, seedDoc: doc })}
                        >
                          <strong>{doc.title}</strong>
                          <span>
                            {normalizeCategory(doc.category)} · {formatDateTimeLabel(doc.uploadedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="notion-settings-help">
                    No uploads yet. Add your first note to populate the workspace activity feed.
                  </p>
                )}
              </article>
              <article className="notion-panel-block notion-overview-activity-panel">
                <div className="notion-panel-head">
                  <h2 className="section-title">Summary activity</h2>
                  <p>Recent AI outputs and the models or sources behind them.</p>
                </div>
                {recentSummaryActivity.length ? (
                  <ul className="notion-overview-activity-list">
                    {recentSummaryActivity.map((entry) => (
                      <li key={`overview-summary-${entry.id}`}>
                        <button
                          type="button"
                          className="notion-overview-activity-item"
                          onClick={() => handleApplySummaryHistoryItem(entry)}
                        >
                          <strong>{entry.title}</strong>
                          <span>
                            {getSummarySourceLabel(entry.summarySource)} · {formatDateTimeLabel(entry.generatedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="notion-settings-help">
                    No summary history yet. Use AI Assistant or summarize a document to build this feed.
                  </p>
                )}
              </article>
            </section>
          )}

          {!showFiles && !showAI && !docPaneVisible && activeWorkspaceSettings.show_usage_chart && (
            <>
              <Suspense fallback={<p className="muted tiny">Loading usage chart...</p>}>
                <UsageChart usageMap={usageMap} />
              </Suspense>
            </>
          )}

          {showAI && !docPaneVisible && (
            <Suspense fallback={<p className="muted tiny">Loading AI assistant...</p>}>
              <AIAssistantPanel
                allowAiTools={activeWorkspaceSettings.allow_ai_tools}
                allowOcr={activeWorkspaceSettings.allow_ocr}
                allowExport={activeWorkspaceSettings.allow_export}
                aiImageInputRef={aiImageInputRef}
                onAIImageChange={handleAIImageChange}
                onOpenAIImagePicker={openAIImagePicker}
                onAnalyzeText={handleAnalyzeText}
                onCopySummary={handleCopySummary}
                onExportSummary={handleExportSummary}
                onEmailSummary={handleEmailSummary}
                onOpenSummaryCenter={handleOpenSummaryCenter}
                isExtracting={isExtracting}
                isAnalyzing={isAnalyzing}
                extractedText={extractedText}
                hideInputText={aiHideInputText}
                onChangeExtractedText={setExtractedText}
                analysisResult={analysisResult}
                summaryHistoryCount={summaryHistory.length}
              />
            </Suspense>
          )}

          {showFiles && !docPaneVisible && (
            <section id="files-section" className="files-section notion-files-section">
              <div className="notion-files-layout">
                <aside className="notion-files-tools">
                  <section className="filters notion-panel-block" aria-labelledby="filters-title">
                    <div className="notion-panel-head">
                      <h2 id="filters-title" className="section-title">Smart Filters</h2>
                      <p>
                        {hasActiveFilters
                          ? `${activeFilterCount} filter${activeFilterCount > 1 ? 's' : ''} active`
                          : 'Search notes by keyword, date range, category, tag, and file type.'}
                      </p>
                    </div>
                    <div className="notion-saved-views-bar" aria-label="Saved views">
                      <div className="notion-saved-views-head">
                        <span>Saved Views</span>
                        <div className="notion-saved-views-actions">
                          <button type="button" className="btn" onClick={() => void handleSaveCurrentView()}>
                            Save Current
                          </button>
                          <button type="button" className="btn" onClick={handleOpenSavedViewsImport}>
                            Import
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={handleExportSavedViews}
                            disabled={!savedViews.length}
                          >
                            Export
                          </button>
                          <button type="button" className="btn" onClick={() => setShortcutsOpen(true)}>
                            Shortcuts
                          </button>
                        </div>
                      </div>
                      <input
                        ref={savedViewsImportInputRef}
                        type="file"
                        accept=".json,application/json"
                        className="sr-only"
                        onChange={handleImportSavedViewsFromFile}
                      />
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
                                onClick={() => handleApplySavedView(view)}
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
                                onClick={() => void handleRenameSavedView(view)}
                                aria-label={`Rename ${view.name}`}
                                title="Rename"
                              >
                                ✎
                              </button>
                              <button
                                type="button"
                                className="notion-saved-view-icon"
                                onClick={() => void handleDeleteSavedView(view)}
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
                          Save your current filters/sort and reuse them in one click.
                        </p>
                      )}
                    </div>

                    <div className="notion-quick-filter-presets" role="group" aria-label="Quick filter presets">
                      {QUICK_FILTER_PRESET_OPTIONS.map((preset) => (
                        <button
                          key={`quick-preset-${preset.id}`}
                          type="button"
                          className={`notion-quick-preset-btn${
                            activeQuickFilterPresetId === preset.id ? ' active' : ''
                          }`}
                          onClick={() => applyQuickFilterPreset(preset.id)}
                          aria-pressed={activeQuickFilterPresetId === preset.id ? 'true' : 'false'}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>

                    <div className="filter-row notion-filter-search-row">
                      <label htmlFor="search-input" className="sr-only">
                        Search
                      </label>
                      <div className="input-with-icon">
                        <svg aria-hidden="true" viewBox="0 0 24 24">
                          <path d="M21 21l-4.3-4.3m1.3-4.7a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        <input
                          id="search-input"
                          ref={searchInputRef}
                          type="search"
                          placeholder="Search title, tags, category, or content"
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

                      <button
                        id="search-btn"
                        className="btn btn-primary"
                        type="button"
                        onClick={applySearch}
                      >
                        Search
                      </button>

                      <button id="clear-filters" className="btn" type="button" onClick={clearFilters}>
                        Clear All
                      </button>
                    </div>
                    <button
                      type="button"
                      className="notion-advanced-toggle"
                      onClick={() => setAdvancedFiltersOpen((prev) => !prev)}
                      aria-expanded={advancedFiltersOpen ? 'true' : 'false'}
                      aria-controls="advanced-filters-panel"
                    >
                      {advancedFiltersOpen ? 'Hide Advanced Filters' : 'Show Advanced Filters'}
                      {advancedFilterCount > 0 ? ` (${advancedFilterCount} active)` : ''}
                    </button>
                    {advancedFiltersOpen && (
                      <div id="advanced-filters-panel" className="notion-advanced-filters" aria-label="Advanced filters">
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
                          <div className="notion-quick-range" role="group" aria-label="Quick date ranges">
                            {FILTER_DATE_RANGE_OPTIONS.map((option) => (
                              <button
                                key={option.id}
                                type="button"
                                className={`notion-quick-range-btn${
                                  activeDateRangePresetId === option.id ? ' active' : ''
                                }`}
                                onClick={() => applyQuickDateRange(option.daysBack)}
                                aria-pressed={activeDateRangePresetId === option.id ? 'true' : 'false'}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="notion-type-quick-switch" role="group" aria-label="Quick type filter">
                          {QUICK_TYPE_FILTER_OPTIONS.map((option) => {
                            const isActive = normalizeFileTypeFilter(filters.fileType) === option.value;
                            return (
                              <button
                                key={`quick-file-type-${option.value}`}
                                type="button"
                                className={`notion-quick-type-btn${isActive ? ' active' : ''}`}
                                onClick={() => {
                                  setSelectedDocumentIds([]);
                                  setDocumentsPage(1);
                                  setFilters((prev) => ({
                                    ...prev,
                                    fileType: isActive ? '' : option.value,
                                  }));
                                }}
                                aria-pressed={isActive ? 'true' : 'false'}
                              >
                                {option.label}
                              </button>
                            );
                          })}
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
                                      tag: prev.tag === tag ? '' : tag
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
                    {activeFilterChips.length > 0 && (
                      <div className="notion-active-filters" aria-label="Active filters">
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
                  </section>
                </aside>

                <UploadPanel
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

                <section className="notion-files-results notion-panel-block notion-results-panel" aria-labelledby="docs-title">
                  <div className="notion-files-results-head">
                    <div className="list-head">
                      <h2 id="docs-title" className="section-title">
                        My Documents
                      </h2>
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
                      <button
                        type="button"
                        className="btn"
                        onClick={() => fetchDocuments(documentsPage)}
                        disabled={documentsLoading || bulkActionLoading || selectAllMatchedLoading}
                      >
                        {documentsLoading ? 'Refreshing...' : 'Refresh'}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={handleOpenTrashModal}
                        disabled={!isLoggedIn || bulkActionLoading || selectAllMatchedLoading}
                        title="Open Trash"
                      >
                        Trash{trashTotal > 0 ? ` (${trashTotal})` : ''}
                      </button>
                    </div>
                  </div>
                  <div className="notion-files-summary-bar">
                    <div className="notion-summary-chips" aria-live="polite">
                      <span className="notion-summary-chip">Matched {documentsTotal}</span>
                      <span className="notion-summary-chip">This page {filteredDocuments.length}</span>
                      <span className="notion-summary-chip">{activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''}</span>
                      {!!selectedDocumentCount && (
                        <span className="notion-summary-chip is-selected">{selectedDocumentCount} selected</span>
                      )}
                      {!!selectedOutsideCurrentPageCount && (
                        <span className="notion-summary-chip">
                          {selectedOutsideCurrentPageCount} from other page(s)
                        </span>
                      )}
                    </div>
                    <div className="notion-summary-actions">
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
                      {!!selectedDocumentCount && (
                        <button
                          type="button"
                          className="btn"
                          onClick={clearSelectedDocuments}
                          disabled={documentsLoading || bulkActionLoading || selectAllMatchedLoading}
                        >
                          Clear Selection
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn"
                        onClick={resetDocumentsView}
                        disabled={documentsLoading || bulkActionLoading || selectAllMatchedLoading}
                      >
                        Reset View
                      </button>
                    </div>
                  </div>
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
                    <p className="muted tiny">Loading documents...</p>
                  )}
                  <Suspense fallback={<p className="muted tiny">Loading document list...</p>}>
                    <DocumentsList
                      documents={filteredDocuments}
                      isLoggedIn={isLoggedIn}
                      meta={`Workspace: ${activeWorkspace?.name || 'Unknown'} · Showing ${filteredDocuments.length} item(s) on page ${documentsPage} of ${documentsPageCount} (${documentsTotal} matched)${selectedDocumentCount ? ` · ${selectedDocumentCount} selected` : ''}`}
                      canEditMetadata={activeWorkspaceSettings.allow_note_editing}
                      canSummarize={activeWorkspaceSettings.allow_ai_tools}
                      canShare={
                        activeWorkspaceSettings.link_sharing_mode !== 'restricted' &&
                        canCurrentUserManageShareLinks
                      }
                      starredDocIdSet={starredDocIdSet}
                      onView={handleView}
                      onDelete={handleDelete}
                      onEdit={handleEdit}
                      onEditCategory={handleEditCategory}
                      onSummarize={handleUseDocumentForAI}
                      onSummarizeRefresh={handleRegenerateDocumentSummary}
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
              </div>
            </section>
          )}
        </main>
      </div>

      {shortcutsOpen && (
        <div
          className="notion-modal-backdrop"
          role="presentation"
          onClick={() => setShortcutsOpen(false)}
        >
          <section
            className="notion-modal-card notion-shortcuts-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="keyboard-shortcuts-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="keyboard-shortcuts-title">Keyboard Shortcuts</h3>
            <p className="notion-settings-help">
              Faster navigation inspired by common note tools. Use Ctrl on Windows/Linux or ⌘ on macOS.
            </p>
            <ul className="notion-shortcuts-list">
              {KEYBOARD_SHORTCUT_ITEMS.map((item) => (
                <li key={item.keys}>
                  <kbd>{item.keys}</kbd>
                  <span>{item.action}</span>
                </li>
              ))}
            </ul>
            <div className="notion-confirm-actions">
              <button type="button" className="btn btn-primary" onClick={() => setShortcutsOpen(false)}>
                Close
              </button>
            </div>
          </section>
        </div>
      )}

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
        actionId={summaryCenterActionId}
        onExportTxt={handleExportSummaryHistoryTxt}
        onExportJson={handleExportSummaryHistoryJson}
        onClearAll={handleClearSummaryHistory}
        onApplyItem={handleApplySummaryHistoryItem}
        onOpenItemDocument={(entry) => {
          const targetId = toPositiveDocId(entry?.docId);
          if (!targetId) return;
          setSummaryCenterOpen(false);
          void openDocumentInPane(targetId, { fromSidebar: true });
        }}
        onRebuildItem={handleRebuildSummaryHistoryItem}
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
          className="notion-modal-backdrop"
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
          className="notion-modal-backdrop"
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

            <section className="notion-settings-block" aria-label="Add account">
              <h4>Add Another Account</h4>
              <div className="notion-inline-panel-grid">
                <input
                  type="text"
                  value={accountDraft.username}
                  onChange={(event) =>
                    setAccountDraft((prev) => ({
                      ...prev,
                      username: event.target.value,
                    }))
                  }
                  placeholder="Account name"
                  autoFocus
                />
                <input
                  type="email"
                  value={accountDraft.email}
                  onChange={(event) =>
                    setAccountDraft((prev) => ({
                      ...prev,
                      email: event.target.value,
                    }))
                  }
                  placeholder="Email (optional)"
                />
              </div>
            </section>

            <div className="notion-modal-actions">
              <button type="button" className="btn btn-primary" onClick={handleSaveManualAccount}>
                Save and Continue to Sign-in
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setAccountManagerOpen(false);
                  navigate('/login');
                }}
              >
                Add from Sign-in Page
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
            documentsLayoutOptions={DOCUMENTS_LAYOUT_OPTIONS}
            documentsSortOptions={DOCUMENTS_SORT_OPTIONS}
            documentsPageSizeOptions={DOCUMENTS_PAGE_SIZE_OPTIONS}
            sidebarDensityOptions={SIDEBAR_DENSITY_OPTIONS}
            accentColorPresets={WORKSPACE_ACCENT_PRESETS}
            sharePolicyPresets={SHARE_POLICY_PRESETS}
            activeSharePolicyPresetId={activeSharePolicyPresetId}
            onClearWorkspaceDocuments={handleClearWorkspaceDocuments}
            onDeleteWorkspace={handleDeleteWorkspace}
            isLoggedIn={isLoggedIn}
            activeWorkspace={activeWorkspace}
            workspaceInsights={{
              totalNotes: dashboardStats.total,
              categoryCount: dashboardStats.categories,
              tagCount: dashboardStats.tags,
              memberCount: workspaceMemberCount,
            }}
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
