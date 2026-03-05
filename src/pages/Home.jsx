import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { todayKey } from '../lib/dates.js';
import { loadUsageMap, persistUsageMap } from '../lib/usage.js';
import { loadAccounts, persistAccounts } from '../lib/accounts.js';
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
const HOME_TAB_OPTIONS = ['home', 'files', 'ai'];
const WORKSPACE_SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'defaults', label: 'Defaults' },
  { id: 'experience', label: 'Experience' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'ai', label: 'AI' },
  { id: 'access', label: 'Access' },
  { id: 'danger', label: 'Danger' },
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
  default_category: DEFAULT_NOTE_CATEGORY,
  auto_categorize: true,
  default_home_tab: 'home',
  recent_items_limit: DEFAULT_SIDEBAR_RECENT_LIMIT,
  allow_uploads: true,
  allow_note_editing: true,
  allow_ai_tools: true,
  allow_ocr: true,
  summary_length: 'medium',
  keyword_limit: 5,
  allow_member_invites: false,
  default_invite_expiry_days: 7,
  default_share_expiry_days: 7,
  link_sharing_mode: 'workspace',
  allow_member_share_management: false,
  max_active_share_links_per_document: 5,
  auto_revoke_previous_share_links: false,
  allow_export: true,
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
const MAX_SAVED_VIEWS_PER_WORKSPACE = 10;
const MAX_UPLOAD_QUEUE_ITEMS = 30;
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
const createUploadQueueId = () => createClientId('upload');

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

  return {
    workspace_icon: workspaceIcon.slice(0, 2) || DEFAULT_WORKSPACE_SETTINGS.workspace_icon,
    description: String(source.description || '').trim().slice(0, 220),
    default_category: normalizeCategory(source.default_category || DEFAULT_WORKSPACE_SETTINGS.default_category),
    auto_categorize: Boolean(source.auto_categorize ?? DEFAULT_WORKSPACE_SETTINGS.auto_categorize),
    default_home_tab: defaultHomeTab,
    recent_items_limit: clamp(
      Number(source.recent_items_limit) || DEFAULT_WORKSPACE_SETTINGS.recent_items_limit,
      MIN_SIDEBAR_RECENT_LIMIT,
      MAX_SIDEBAR_RECENT_LIMIT
    ),
    allow_uploads: Boolean(source.allow_uploads ?? DEFAULT_WORKSPACE_SETTINGS.allow_uploads),
    allow_note_editing: Boolean(
      source.allow_note_editing ?? DEFAULT_WORKSPACE_SETTINGS.allow_note_editing
    ),
    allow_ai_tools: Boolean(source.allow_ai_tools ?? DEFAULT_WORKSPACE_SETTINGS.allow_ai_tools),
    allow_ocr: Boolean(source.allow_ocr ?? DEFAULT_WORKSPACE_SETTINGS.allow_ocr),
    summary_length: summaryLength,
    keyword_limit: clamp(Number(source.keyword_limit) || DEFAULT_WORKSPACE_SETTINGS.keyword_limit, 3, 12),
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
      authToken: '',
      lastActiveAt: '',
    };
  }
  if (typeof raw !== 'object') return null;

  const username = String(raw.username || '').trim();
  if (!username) return null;
  return {
    username,
    email: String(raw.email || '').trim(),
    authToken: String(raw.authToken || raw.auth_token || '').trim(),
    lastActiveAt: String(raw.lastActiveAt || ''),
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
      authToken: normalized.authToken || existing.authToken || '',
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

const sortByNewestUpload = (a, b) => {
  const timeDiff = toTimeMs(b.uploadedAt) - toTimeMs(a.uploadedAt);
  if (timeDiff !== 0) return timeDiff;
  return Number(b.id || 0) - Number(a.id || 0);
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
  const [documents, setDocuments] = useState([]);
  const [documentsTotal, setDocumentsTotal] = useState(0);
  const [documentsPage, setDocumentsPage] = useState(1);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsLoadError, setDocumentsLoadError] = useState('');
  const [documentsPageSize, setDocumentsPageSize] = useState(
    () => loadFilesViewPreferences().pageSize
  );
  const [documentsSort, setDocumentsSort] = useState(
    () => loadFilesViewPreferences().sort
  );
  const [documentsLayout, setDocumentsLayout] = useState(
    () => loadFilesViewPreferences().layout
  );
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
  const [availableTags, setAvailableTags] = useState([]);
  const [availableCategories, setAvailableCategories] = useState([]);
  const [availableFileTypeCounts, setAvailableFileTypeCounts] = useState({});
  const [savedViews, setSavedViews] = useState([]);
  const [activeSavedViewId, setActiveSavedViewId] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [dragUploadActive, setDragUploadActive] = useState(false);
  const [uploadQueue, setUploadQueue] = useState([]);
  const [uploadQueueRunning, setUploadQueueRunning] = useState(false);
  const [uploadQueueExpanded, setUploadQueueExpanded] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();
  const workspaceMenuRef = useRef(null);
  const recentMenuRef = useRef(null);
  const searchInputRef = useRef(null);
  const savedViewsImportInputRef = useRef(null);
  const uploadDragDepthRef = useRef(0);
  const documentsRequestSeqRef = useRef(0);
  const aiImageInputRef = useRef(null);
  const toastTimerRef = useRef(null);
  const confirmResolverRef = useRef(null);
  const inputDialogResolverRef = useRef(null);

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [searchDraft, setSearchDraft] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(
    () => Boolean(sessionStorage.getItem('username') && sessionStorage.getItem('auth_token'))
  );
  const [showFiles, setShowFiles] = useState(() => location.state?.showFiles || false);
  const [showAI, setShowAI] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
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
  const [inviteCopied, setInviteCopied] = useState(false);
  const [accountDraft, setAccountDraft] = useState({ username: '', email: '' });
  const [savedAccounts, setSavedAccounts] = useState(() => normalizeAccounts(loadAccounts()));
  const [workspaceState, setWorkspaceState] = useState(() =>
    loadWorkspaceState(sessionStorage.getItem('username') || 'Guest')
  );
  const [sidebarMenuDocId, setSidebarMenuDocId] = useState(null);
  const [sidebarRecentIds, setSidebarRecentIds] = useState([]);
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
  const [extractedText, setExtractedText] = useState('');
  const [analysisResult, setAnalysisResult] = useState(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [uploadCategory, setUploadCategory] = useState('');

  const [fileHint, setFileHint] = useState('');
  const fileInputRef = useRef(null);
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
  const activeWorkspaceSettings = useMemo(
    () => normalizeWorkspaceSettings(activeWorkspace?.settings),
    [activeWorkspace?.settings]
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
  const workspaceMemberCount = useMemo(
    () => memberCountOfWorkspace(activeWorkspace, accountName),
    [activeWorkspace, accountName]
  );
  const inviteItems = useMemo(
    () => (Array.isArray(activeWorkspace?.invites) ? activeWorkspace.invites : []),
    [activeWorkspace?.invites]
  );
  const inviteCount = inviteItems.length;
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
      return nextState;
    } catch (err) {
      console.error('Failed to refresh workspaces', err);
      return workspaceState;
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const buildDocumentsQueryParams = ({
    limit,
    offset,
    sort,
    includeMeta = false,
    includeFacets = false,
  } = {}) => {
    const params = new URLSearchParams({ username });
    if (activeWorkspaceId) params.set('workspace_id', activeWorkspaceId);
    if (includeMeta) params.set('include_meta', '1');
    if (includeFacets) params.set('include_facets', '1');
    if (Number.isFinite(Number(limit)) && Number(limit) > 0) params.set('limit', String(Number(limit)));
    if (Number.isFinite(Number(offset)) && Number(offset) >= 0) params.set('offset', String(Number(offset)));
    const sortKey = normalizeDocumentsSort(sort || documentsSort);
    if (sortKey) params.set('sort', sortKey);
    if (filters.query) params.set('q', filters.query);
    if (filters.start) params.set('start_date', filters.start);
    if (filters.end) params.set('end_date', filters.end);
    if (filters.tag) params.set('tag', filters.tag);
    if (filters.category) params.set('category', filters.category);
    if (filters.fileType) params.set('file_type', normalizeFileTypeFilter(filters.fileType));
    return params;
  };

  const fetchDocuments = async (targetPage = documentsPage) => {
    const requestSeq = documentsRequestSeqRef.current + 1;
    documentsRequestSeqRef.current = requestSeq;
    const commitIfLatest = (callback) => {
      if (requestSeq !== documentsRequestSeqRef.current) return;
      callback();
    };

    if (!username || !authToken) {
      commitIfLatest(() => {
        setDocuments([]);
        setDocumentsTotal(0);
        setDocumentsLoading(false);
        setDocumentsLoadError('');
        setAvailableTags([]);
        setAvailableCategories([]);
        setAvailableFileTypeCounts({});
      });
      return;
    }
    if (!activeWorkspaceId) {
      commitIfLatest(() => {
        setDocuments([]);
        setDocumentsTotal(0);
        setDocumentsLoading(false);
        setDocumentsLoadError('');
        setAvailableTags([]);
        setAvailableCategories([]);
        setAvailableFileTypeCounts({});
      });
      return;
    }
    const safePage = Math.max(1, Number(targetPage) || 1);
    const pageSize = normalizeDocumentsPageSize(documentsPageSize);
    const offset = (safePage - 1) * pageSize;
    const params = buildDocumentsQueryParams({
      limit: pageSize,
      offset,
      sort: documentsSort,
      includeMeta: true,
      includeFacets: true,
    });

    commitIfLatest(() => {
      setDocumentsLoading(true);
      setDocumentsLoadError('');
    });
    try {
      const res = await fetch(`/api/documents?${params.toString()}`);
      if (res.ok) {
        const payload = await res.json().catch(() => ({}));
        const items = Array.isArray(payload?.items) ? payload.items : [];
        const total = Number(payload?.total);
        const facetTags = Array.isArray(payload?.facets?.tags) ? payload.facets.tags : [];
        const facetCategories = Array.isArray(payload?.facets?.categories) ? payload.facets.categories : [];
        const facetFileTypeCounts = normalizeFacetFileTypeCounts(payload?.facets?.file_types);
        const normalized = items.map(normalizeDocument);
        const normalizedFacetTags = Array.from(
          new Set(
            facetTags
              .map((tag) => String(tag || '').trim())
              .filter(Boolean)
          )
        ).sort((a, b) => a.localeCompare(b));
        const normalizedFacetCategories = Array.from(
          new Set(
            facetCategories
              .map((category) => normalizeCategory(category))
              .filter(Boolean)
          )
        ).sort((a, b) => a.localeCompare(b));
        const hasFacetPayload =
          normalizedFacetTags.length ||
          normalizedFacetCategories.length ||
          Object.keys(facetFileTypeCounts).length;
        const fallbackTags = new Set();
        const fallbackCategories = new Set();
        const fallbackFileTypeCounts = buildFileTypeCountsFromDocuments(normalized);
        if (!hasFacetPayload) {
          normalized.forEach((doc) => {
            (doc.tags || []).forEach((tag) => fallbackTags.add(tag));
            fallbackCategories.add(normalizeCategory(doc.category));
          });
        }
        commitIfLatest(() => {
          setDocuments(normalized);
          setDocumentsTotal(Number.isFinite(total) ? Math.max(0, total) : normalized.length);
          if (hasFacetPayload) {
            setAvailableTags(normalizedFacetTags);
            setAvailableCategories(normalizedFacetCategories);
            setAvailableFileTypeCounts(
              Object.keys(facetFileTypeCounts).length ? facetFileTypeCounts : fallbackFileTypeCounts
            );
          } else {
            setAvailableTags(Array.from(fallbackTags).sort((a, b) => a.localeCompare(b)));
            setAvailableCategories(Array.from(fallbackCategories).sort((a, b) => a.localeCompare(b)));
            setAvailableFileTypeCounts(fallbackFileTypeCounts);
          }
        });
      } else {
        const payload = await res.json().catch(() => ({}));
        commitIfLatest(() => {
          setDocuments([]);
          setDocumentsTotal(0);
          setAvailableTags([]);
          setAvailableCategories([]);
          setAvailableFileTypeCounts({});
          setDocumentsLoadError(payload.error || 'Failed to load documents');
        });
      }
    } catch (err) {
      console.error('Failed to fetch documents', err);
      commitIfLatest(() => {
        setDocuments([]);
        setDocumentsTotal(0);
        setAvailableTags([]);
        setAvailableCategories([]);
        setAvailableFileTypeCounts({});
        setDocumentsLoadError('Failed to load documents');
      });
    } finally {
      commitIfLatest(() => {
        setDocumentsLoading(false);
      });
    }
  };

  useEffect(() => {
    fetchDocuments(documentsPage);
  }, [
    username,
    authToken,
    activeWorkspaceId,
    documentsPage,
    documentsPageSize,
    documentsSort,
    filters.query,
    filters.start,
    filters.end,
    filters.tag,
    filters.category,
    filters.fileType,
  ]);

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
    setAvailableTags([]);
    setAvailableCategories([]);
    setAvailableFileTypeCounts({});
    setSelectedDocumentIds([]);
    setSelectAllMatchedLoading(false);
    setBulkCategoryDraft('');
    setBulkTagsDraft('');
    setBulkResultSummary(DEFAULT_BULK_RESULT_SUMMARY);
    setDragUploadActive(false);
    setUploadQueue([]);
    setUploadQueueRunning(false);
    uploadDragDepthRef.current = 0;
  }, [activeWorkspaceId, username, authToken]);

  useEffect(() => {
    persistFilesViewPreferences({
      pageSize: documentsPageSize,
      sort: documentsSort,
      layout: documentsLayout,
    });
  }, [documentsPageSize, documentsSort, documentsLayout]);

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
      setDocuments([]);
      setDocumentsTotal(0);
      setDocumentsPage(1);
      setDocumentsLoading(false);
      setDocumentsLoadError('');
      setAvailableTags([]);
      setAvailableCategories([]);
      setSidebarRecentIds([]);
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
      setDragUploadActive(false);
      setUploadQueue([]);
      setUploadQueueRunning(false);
      uploadDragDepthRef.current = 0;
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
          original.authToken !== item.authToken ||
          original.lastActiveAt !== item.lastActiveAt
        );
      })
    ) {
      setSavedAccounts(normalized);
      return;
    }
    persistAccounts(normalized);
  }, [savedAccounts]);

  useEffect(() => {
    refreshWorkspaces({ preserveActive: false });
    setWorkspaceInviteDraft('');
    setLatestInviteLinks([]);
    setInviteCopied(false);
    setWorkspaceSettingsOpen(false);
    setWorkspaceInviteOpen(false);
    setAccountManagerOpen(false);
  }, [accountName, isLoggedIn, username]);

  useEffect(() => {
    const nextViews = loadSavedViews(accountName, activeWorkspaceId);
    setSavedViews(nextViews);
    setActiveSavedViewId('');
  }, [accountName, activeWorkspaceId]);

  useEffect(() => {
    persistSavedViews(accountName, activeWorkspaceId, savedViews);
  }, [accountName, activeWorkspaceId, savedViews]);

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
      authToken,
      lastActiveAt: new Date().toISOString(),
    });
    setSavedAccounts((prev) => {
      if (
        prev.length === nextAccounts.length &&
        prev.every(
          (item, idx) =>
            item.username === nextAccounts[idx].username &&
            item.email === nextAccounts[idx].email &&
            item.authToken === nextAccounts[idx].authToken &&
            item.lastActiveAt === nextAccounts[idx].lastActiveAt
        )
      ) {
        return prev;
      }
      return nextAccounts;
    });
  }, [username, accountEmail, authToken]);

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
      uploadDragDepthRef.current = 0;
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
        setShortcutsOpen(false);
        setInviteCopied(false);
        setDragUploadActive(false);
        uploadDragDepthRef.current = 0;
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

  const filteredDocuments = documents;
  const documentsPageCount = useMemo(
    () =>
      Math.max(
        1,
        Math.ceil((Number(documentsTotal) || 0) / normalizeDocumentsPageSize(documentsPageSize))
      ),
    [documentsTotal, documentsPageSize]
  );

  useEffect(() => {
    if (documentsPage <= documentsPageCount) return;
    setDocumentsPage(documentsPageCount);
  }, [documentsPage, documentsPageCount]);

  const pageTags = useMemo(() => {
    const bag = new Set();
    documents.forEach((doc) => (doc.tags || []).forEach((tag) => bag.add(tag)));
    return Array.from(bag).sort((a, b) => a.localeCompare(b));
  }, [documents]);
  const tags = useMemo(() => {
    const bag = new Set([...(availableTags || []), ...pageTags]);
    return Array.from(bag).sort((a, b) => a.localeCompare(b));
  }, [availableTags, pageTags]);
  const pageCategories = useMemo(() => {
    const bag = new Set();
    documents.forEach((doc) => {
      const category = normalizeCategory(doc.category);
      if (category) bag.add(category);
    });
    return Array.from(bag).sort((a, b) => a.localeCompare(b));
  }, [documents]);
  const categories = useMemo(() => {
    const bag = new Set([...(availableCategories || []), ...pageCategories]);
    return Array.from(bag).sort((a, b) => a.localeCompare(b));
  }, [availableCategories, pageCategories]);
  const categorySuggestions = useMemo(() => {
    const bag = new Set([...SUGGESTED_CATEGORIES, ...categories]);
    return Array.from(bag).sort((a, b) => a.localeCompare(b));
  }, [categories]);
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

  useEffect(() => {
    // If the selected tag no longer exists after edits, clear stale filter automatically.
    if (!filters.tag) return;
    if (!tags.includes(filters.tag)) {
      setFilters((prev) => ({ ...prev, tag: '' }));
    }
  }, [tags, filters.tag]);
  useEffect(() => {
    if (!filters.category) return;
    if (!categories.includes(filters.category)) {
      setFilters((prev) => ({ ...prev, category: '' }));
    }
  }, [categories, filters.category]);
  const advancedFilterCount = useMemo(() => {
    let count = 0;
    if (filters.start || filters.end) count += 1;
    if (filters.category) count += 1;
    if (filters.tag) count += 1;
    if (filters.fileType) count += 1;
    return count;
  }, [filters.start, filters.end, filters.category, filters.tag, filters.fileType]);
  const hasAdvancedFilters = advancedFilterCount > 0;
  useEffect(() => {
    if (hasAdvancedFilters) {
      setAdvancedFiltersOpen(true);
    }
  }, [hasAdvancedFilters]);
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.query) count += 1;
    if (filters.start || filters.end) count += 1;
    if (filters.category) count += 1;
    if (filters.tag) count += 1;
    if (filters.fileType) count += 1;
    return count;
  }, [filters.query, filters.start, filters.end, filters.category, filters.tag, filters.fileType]);
  const fileTypeFilterCounts = useMemo(() => {
    const source =
      availableFileTypeCounts && typeof availableFileTypeCounts === 'object' ? availableFileTypeCounts : {};
    const output = { '': Math.max(0, Number(documentsTotal) || 0) };
    FILE_TYPE_FILTER_OPTIONS.forEach((option) => {
      const key = normalizeFileTypeFilter(option.value);
      if (!key) return;
      output[key] = Math.max(0, Number(source[key]) || 0);
    });
    return output;
  }, [availableFileTypeCounts, documentsTotal]);
  const hasActiveFilters = activeFilterCount > 0;
  const activeDateRangePresetId = useMemo(() => {
    if (!filters.start && !filters.end) return 'all';
    const matched = FILTER_DATE_RANGE_OPTIONS.find((option) => {
      if (option.daysBack === null) return false;
      const range = getQuickDateRange(option.daysBack);
      return range.start === filters.start && range.end === filters.end;
    });
    return matched?.id || '';
  }, [filters.start, filters.end]);
  const activeFilterChips = useMemo(() => {
    const chips = [];
    const query = String(filters.query || '').trim();
    if (query) {
      chips.push({ id: 'query', label: `Keyword: ${query}` });
    }
    if (filters.start || filters.end) {
      chips.push({
        id: 'date',
        label: `Date: ${formatDisplayDateValue(filters.start)} - ${formatDisplayDateValue(filters.end)}`,
      });
    }
    if (filters.category) {
      chips.push({ id: 'category', label: `Category: ${filters.category}` });
    }
    if (filters.tag) {
      chips.push({ id: 'tag', label: `Tag: ${filters.tag}` });
    }
    if (filters.fileType) {
      chips.push({
        id: 'fileType',
        label: `Type: ${getFileTypeFilterLabel(filters.fileType)}`,
      });
    }
    return chips;
  }, [filters.query, filters.start, filters.end, filters.category, filters.tag, filters.fileType]);
  const uploadQueueSummary = useMemo(() => {
    const total = uploadQueue.length;
    let queued = 0;
    let uploading = 0;
    let success = 0;
    let failed = 0;
    uploadQueue.forEach((item) => {
      if (item.status === 'uploading') uploading += 1;
      else if (item.status === 'success') success += 1;
      else if (item.status === 'failed') failed += 1;
      else queued += 1;
    });
    const done = success + failed;
    const progress = total ? Math.round((done / total) * 100) : 0;
    return { total, queued, uploading, success, failed, progress };
  }, [uploadQueue]);
  const canRetryFailedUploads = uploadQueueSummary.failed > 0 && !uploadQueueRunning;
  const canClearUploadQueue = !uploadQueueRunning && (uploadQueueSummary.success > 0 || uploadQueueSummary.failed > 0);
  useEffect(() => {
    if (!uploadQueue.length) {
      setUploadQueueExpanded(true);
      return;
    }
    if (uploadQueueRunning || uploadQueueSummary.failed > 0) {
      setUploadQueueExpanded(true);
    }
  }, [uploadQueue.length, uploadQueueRunning, uploadQueueSummary.failed]);
  const currentViewSnapshot = useMemo(
    () => ({
      filters: {
        query: String(filters.query || '').trim(),
        start: String(filters.start || '').trim(),
        end: String(filters.end || '').trim(),
        tag: String(filters.tag || '').trim(),
        category: String(filters.category || '').trim(),
        fileType: normalizeFileTypeFilter(filters.fileType),
      },
      sort: normalizeDocumentsSort(documentsSort),
      pageSize: normalizeDocumentsPageSize(documentsPageSize),
      layout: normalizeDocumentsLayout(documentsLayout),
    }),
    [
      filters.query,
      filters.start,
      filters.end,
      filters.tag,
      filters.category,
      filters.fileType,
      documentsSort,
      documentsPageSize,
      documentsLayout,
    ]
  );
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

  const formatDisplayDate = (value) => formatDisplayDateValue(value);

  const formatDateTimeLabel = (value) => {
    if (!value) return 'Unknown';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return String(value);
    return dt.toLocaleString();
  };

  const sortedUploadIds = useMemo(
    () =>
      documents
        .slice()
        .sort(sortByNewestUpload)
        .map((doc) => Number(doc.id))
        .filter((id) => Number.isFinite(id)),
    [documents]
  );

  useEffect(() => {
    // Keep sidebar recent list in a stable LRU order while syncing with current documents.
    setSidebarRecentIds((prev) => {
      const validIdSet = new Set(sortedUploadIds);
      const cleanedPrev = prev.filter((id) => validIdSet.has(id));
      const existingIdSet = new Set(cleanedPrev);
      const newlyAdded = sortedUploadIds.filter((id) => !existingIdSet.has(id));
      const next = [...newlyAdded, ...cleanedPrev].slice(0, activeRecentLimit);
      if (next.length === prev.length && next.every((id, idx) => id === prev[idx])) return prev;
      return next;
    });
  }, [sortedUploadIds, activeRecentLimit]);

  const sidebarDocs = useMemo(() => {
    const byId = new Map(documents.map((doc) => [Number(doc.id), doc]));
    return sidebarRecentIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .slice(0, activeRecentLimit);
  }, [documents, sidebarRecentIds, activeRecentLimit]);

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
  };

  const clearActiveDocShareState = () => {
    setActiveDocShareLinks([]);
    setActiveDocShareLinksLoading(false);
    setActiveDocShareLinksError('');
    setActiveDocShareActionLoadingId(0);
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
    sessionStorage.removeItem('username');
    sessionStorage.removeItem('email');
    sessionStorage.removeItem('auth_token');
    sessionStorage.removeItem('loginAt');
    setIsLoggedIn(false);
    setDocuments([]);
    setDocumentsTotal(0);
    setDocumentsPage(1);
    setDocumentsLoading(false);
    setDocumentsLoadError('');
    setAvailableTags([]);
    setAvailableCategories([]);
    setSidebarRecentIds([]);
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
    setDragUploadActive(false);
    setUploadQueue([]);
    setUploadQueueRunning(false);
    uploadDragDepthRef.current = 0;
    setWorkspaceMenuOpen(false);
    closeWorkspaceDialogs();

    if (forgetCurrent && currentUsername) {
      setSavedAccounts((prev) => prev.filter((item) => item.username !== currentUsername));
    }
  };

  const handleSwitchAccount = (account) => {
    const target = normalizeAccountRecord(account);
    if (!target) return;

    sessionStorage.setItem('username', target.username);
    if (target.email) sessionStorage.setItem('email', target.email);
    else sessionStorage.removeItem('email');
    if (target.authToken) {
      sessionStorage.setItem('auth_token', target.authToken);
      sessionStorage.setItem('loginAt', new Date().toISOString());
    } else {
      sessionStorage.removeItem('auth_token');
      sessionStorage.removeItem('loginAt');
    }

    setIsLoggedIn(Boolean(target.authToken));
    setDocuments([]);
    setDocumentsTotal(0);
    setDocumentsPage(1);
    setDocumentsLoading(false);
    setDocumentsLoadError('');
    setAvailableTags([]);
    setAvailableCategories([]);
    setSidebarRecentIds([]);
    setWorkspaceMenuOpen(false);
    closeWorkspaceDialogs();
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
    setSavedAccounts((prev) => upsertAccount(prev, target));
    if (!target.authToken) {
      showToast('This account has no active session token. Please sign in before accessing cloud data.', 'warning');
    }
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
        setDocuments([]);
        setDocumentsTotal(0);
        setDocumentsPage(1);
        setDocumentsLoading(false);
        setDocumentsLoadError('');
        setAvailableTags([]);
        setAvailableCategories([]);
        setSidebarRecentIds([]);
        setSidebarMenuDocId(null);
        setActiveDoc(null);
        setActiveDocError('');
        setActiveDocLoading(false);
        setActiveDocFileVersion(0);
        setActiveDocEditMode(false);
        setActiveDocDraftHtml('');
        setActiveDocSaveError('');
        clearActiveDocShareState();
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
    setDocuments([]);
    setDocumentsTotal(0);
    setDocumentsPage(1);
    setDocumentsLoading(false);
    setDocumentsLoadError('');
    setAvailableTags([]);
    setAvailableCategories([]);
    setSidebarRecentIds([]);
    setSidebarMenuDocId(null);
    setActiveDoc(null);
    setActiveDocError('');
    setActiveDocLoading(false);
    setActiveDocFileVersion(0);
    setActiveDocEditMode(false);
    setActiveDocDraftHtml('');
    setActiveDocSaveError('');
    clearActiveDocShareState();
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
    setDocuments([]);
    setDocumentsTotal(0);
    setDocumentsPage(1);
    setDocumentsLoading(false);
    setDocumentsLoadError('');
    setAvailableTags([]);
    setAvailableCategories([]);
    setSidebarRecentIds([]);
    setSidebarMenuDocId(null);
    setActiveDoc(null);
    setActiveDocError('');
    setActiveDocLoading(false);
    setActiveDocFileVersion(0);
    setActiveDocEditMode(false);
    setActiveDocDraftHtml('');
    setActiveDocSaveError('');
    clearActiveDocShareState();
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

        const links = Array.isArray(payload.created)
          ? payload.created.map((item) => item?.invite_url).filter(Boolean)
          : [];
        setLatestInviteLinks(links);
        setWorkspaceInviteDraft('');
        setInviteCopied(false);
        await refreshWorkspaces({ preferredWorkspaceId: activeWorkspace.id });

        const failedEmails = Array.isArray(payload.send_errors)
          ? payload.send_errors.map((item) => item?.email).filter(Boolean)
          : [];
        if (failedEmails.length) {
          showToast(`Failed to send invitation emails: ${failedEmails.join(', ')}`, 'warning');
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
    setInviteCopied(false);
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

  const handleCopyInviteLink = async () => {
    if (!workspaceInviteLink) {
      showToast('There is no invitation link to copy.', 'warning');
      return;
    }
    try {
      await navigator.clipboard.writeText(workspaceInviteLink);
      setInviteCopied(true);
    } catch {
      showToast('Copy failed. Please copy the link manually.', 'error');
    }
  };

  const handleSaveManualAccount = () => {
    const draft = normalizeAccountRecord(accountDraft);
    const target = draft?.username === storedUsername && authToken
      ? { ...draft, authToken }
      : draft;
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
    setSavedAccounts((prev) => prev.filter((item) => item.username !== target));
  };

  const describeFiles = (fileList) =>
    fileList.length
      ? `Selected: ${fileList
          .map((file) => {
            const mb = (file.size / (1024 * 1024)).toFixed(2);
            return `${file.name} (${mb} MB)`;
          })
          .join(', ')}`
      : '';

  const formatFileSize = (size) => {
    const bytes = Number(size) || 0;
    if (bytes <= 0) return '0 KB';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const bumpSidebarRecent = (docId) => {
    const id = Number(docId);
    if (!Number.isFinite(id)) return;
    setSidebarRecentIds((prev) => [id, ...prev.filter((item) => item !== id)].slice(0, activeRecentLimit));
  };

  const handleFileChange = (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      setFileHint('');
      return;
    }
    setFileHint(describeFiles(files));
  };

  const uploadSingleFile = async (file, activeUser) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('username', activeUser);
    if (activeWorkspaceId) {
      formData.append('workspace_id', activeWorkspaceId);
    }
    const preferredCategory = uploadCategory.trim()
      || (!activeWorkspaceSettings.auto_categorize ? activeWorkspaceSettings.default_category : '');
    if (preferredCategory) {
      formData.append('category', preferredCategory);
    }
    try {
      const response = await fetch('/api/documents/upload', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          ok: false,
          message: String(errorData?.error || 'Upload failed'),
        };
      }
      return { ok: true, message: '' };
    } catch {
      return {
        ok: false,
        message: 'Network error. Is backend running?',
      };
    }
  };

  const processUploadQueueItems = async (items) => {
    if (!items.length) return { successCount: 0, totalCount: 0, failedCount: 0 };
    const activeUser = sessionStorage.getItem('username');
    let successCount = 0;

    setUploadQueueRunning(true);
    try {
      for (const item of items) {
        setUploadQueue((prev) =>
          prev.map((row) =>
            row.id === item.id
              ? {
                  ...row,
                  status: 'uploading',
                  progress: 20,
                  message: '',
                }
              : row
          )
        );
        const result = await uploadSingleFile(item.file, activeUser);
        if (result.ok) successCount += 1;
        setUploadQueue((prev) =>
          prev.map((row) =>
            row.id === item.id
              ? {
                  ...row,
                  status: result.ok ? 'success' : 'failed',
                  progress: result.ok ? 100 : 0,
                  message: result.ok ? 'Uploaded' : result.message,
                }
              : row
          )
        );
      }
    } finally {
      setUploadQueueRunning(false);
    }

    const totalCount = items.length;
    const failedCount = Math.max(0, totalCount - successCount);
    return { successCount, totalCount, failedCount };
  };

  const uploadFiles = async (candidateFiles) => {
    if (!isLoggedIn) {
      showToast('Please sign in before uploading.', 'warning');
      return { successCount: 0, totalCount: 0 };
    }
    if (!activeWorkspaceSettings.allow_uploads) {
      showToast('Uploads are disabled in this workspace settings.', 'warning');
      return { successCount: 0, totalCount: 0 };
    }
    if (!activeWorkspaceId) {
      showToast('Please select a workspace first.', 'warning');
      return { successCount: 0, totalCount: 0 };
    }
    const files = Array.from(candidateFiles || []).filter((file) => file instanceof File);
    if (!files.length) {
      showToast('Please choose at least one file first.', 'warning');
      return { successCount: 0, totalCount: 0 };
    }
    if (uploadQueueRunning) {
      showToast('Uploads are in progress. Please wait for current queue.', 'warning');
      return { successCount: 0, totalCount: files.length };
    }

    const availableSlots = Math.max(0, MAX_UPLOAD_QUEUE_ITEMS - uploadQueue.length);
    if (availableSlots <= 0) {
      showToast(
        `Upload queue is full (max ${MAX_UPLOAD_QUEUE_ITEMS}). Clear finished items before adding more.`,
        'warning'
      );
      return { successCount: 0, totalCount: files.length };
    }

    const acceptedFiles = files.slice(0, availableSlots);
    if (acceptedFiles.length < files.length) {
      showToast(
        `Queue accepts up to ${MAX_UPLOAD_QUEUE_ITEMS} items. Added first ${acceptedFiles.length} file(s).`,
        'warning'
      );
    }

    const queueItems = acceptedFiles.map((file) => ({
      id: createUploadQueueId(),
      file,
      name: file.name,
      size: file.size,
      status: 'queued',
      progress: 0,
      message: '',
    }));
    setUploadQueue((prev) => [...queueItems, ...prev]);

    const { successCount, totalCount, failedCount } = await processUploadQueueItems(queueItems);
    if (successCount > 0) {
      const shouldRefetchViaPageReset = documentsPage !== 1;
      setDocumentsPage(1);
      if (!shouldRefetchViaPageReset) {
        await fetchDocuments(1);
      }
    }
    if (failedCount > 0) {
      showToast(`Upload finished: ${successCount}/${totalCount} success, ${failedCount} failed.`, 'warning');
    } else {
      showToast(`Upload complete! (${successCount}/${totalCount} success)`, 'success');
    }
    return { successCount, totalCount };
  };

  const handleRetryFailedUploads = async () => {
    if (uploadQueueRunning) return;
    const failedItems = uploadQueue.filter((item) => item.status === 'failed' && item.file instanceof File);
    if (!failedItems.length) {
      showToast('No failed uploads to retry.', 'info');
      return;
    }
    setUploadQueue((prev) =>
      prev.map((item) =>
        item.status === 'failed'
          ? {
              ...item,
              status: 'queued',
              progress: 0,
              message: '',
            }
          : item
      )
    );
    const { successCount, totalCount, failedCount } = await processUploadQueueItems(failedItems);
    if (successCount > 0) {
      const shouldRefetchViaPageReset = documentsPage !== 1;
      setDocumentsPage(1);
      if (!shouldRefetchViaPageReset) {
        await fetchDocuments(1);
      }
    }
    if (failedCount > 0) {
      showToast(`Retry finished: ${successCount}/${totalCount} succeeded.`, 'warning');
    } else {
      showToast('All failed uploads retried successfully.', 'success');
    }
  };

  const handleClearCompletedUploads = () => {
    if (uploadQueueRunning) return;
    setUploadQueue((prev) => prev.filter((item) => item.status === 'queued' || item.status === 'uploading'));
  };

  const handleUpload = async (event) => {
    event.preventDefault();
    const files = Array.from(fileInputRef.current?.files || []);
    const { successCount } = await uploadFiles(files);
    if (successCount > 0 && fileInputRef.current) {
      fileInputRef.current.value = '';
      setFileHint('');
    }
  };

  const handleUploadDragEnter = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!activeWorkspaceSettings.allow_uploads) return;
    uploadDragDepthRef.current += 1;
    setDragUploadActive(true);
  };

  const handleUploadDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!activeWorkspaceSettings.allow_uploads) return;
    if (!dragUploadActive) setDragUploadActive(true);
  };

  const handleUploadDragLeave = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!activeWorkspaceSettings.allow_uploads) return;
    uploadDragDepthRef.current = Math.max(0, uploadDragDepthRef.current - 1);
    if (uploadDragDepthRef.current === 0) {
      setDragUploadActive(false);
    }
  };

  const handleUploadDrop = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!activeWorkspaceSettings.allow_uploads) return;
    uploadDragDepthRef.current = 0;
    setDragUploadActive(false);
    const droppedFiles = Array.from(event.dataTransfer?.files || []).filter((file) => file instanceof File);
    if (!droppedFiles.length) return;
    setFileHint(describeFiles(droppedFiles));
    const { successCount } = await uploadFiles(droppedFiles);
    if (successCount > 0 && fileInputRef.current) {
      fileInputRef.current.value = '';
      setFileHint('');
    }
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

  const handleAnalyzeText = async () => {
    if (!activeWorkspaceSettings.allow_ai_tools) {
      showToast('AI tools are disabled in this workspace settings.', 'warning');
      return;
    }
    if (!extractedText.trim()) {
      showToast('The text box is empty. Cannot analyze.', 'warning');
      return;
    }

    setIsAnalyzing(true);
    try {
      const response = await fetch('/api/analyze-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username || '',
          workspace_id: activeWorkspaceId || '',
          text: extractedText,
          summary_length: activeWorkspaceSettings.summary_length,
          keyword_limit: activeWorkspaceSettings.keyword_limit,
        }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        showToast(`Analysis failed: ${data.error || 'Service error'}`, 'error');
        return;
      }

      setAnalysisResult(data);
    } catch (error) {
      console.error('Analyze text failed:', error);
      showToast('Text analysis request failed. Please try again later.', 'error');
    } finally {
      setIsAnalyzing(false);
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
      showToast('Summary copied to clipboard.', 'success');
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

  const handleUseDocumentForAI = (doc) => {
    if (!activeWorkspaceSettings.allow_ai_tools) {
      showToast('AI tools are disabled in this workspace settings.', 'warning');
      return;
    }
    const text = String(doc?.content || '').trim();
    if (!text) {
      showToast('This note has no extracted text yet.', 'warning');
      return;
    }
    closeDocumentPane();
    setExtractedText(text);
    setAnalysisResult(null);
    setShowFiles(false);
    setShowAI(true);
    window.requestAnimationFrame(() => {
      document.getElementById('ai-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
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
    try {
      const res = await fetch(`/api/documents/${activeDoc.id}/share-links`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Failed to revoke all share links');
      setActiveDocShareLinks(Array.isArray(payload.items) ? payload.items : []);
      showToast(`Revoked ${payload.revoked_count || 0} share link(s).`, 'success');
    } catch (err) {
      showToast(err.message || 'Failed to revoke all share links', 'error');
    } finally {
      setActiveDocShareActionLoadingId(0);
    }
  };

  const handleCopyExistingShareLink = async (shareUrl) => {
    const value = String(shareUrl || '').trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast('Share link copied.', 'success');
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
      showToast(
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

      setDocuments([]);
      setDocumentsTotal(0);
      setDocumentsPage(1);
      setDocumentsLoading(false);
      setDocumentsLoadError('');
      setAvailableTags([]);
      setAvailableCategories([]);
      setSidebarRecentIds([]);
      setSidebarMenuDocId(null);
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

  const openDocumentInPane = async (docId, options = {}) => {
    const { fromSidebar = false } = options;
    bumpSidebarRecent(docId);
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
      setActiveDoc(normalizeDocument(data));
      setActiveDocFileVersion(Date.now());
    } catch (err) {
      setActiveDoc(null);
      setActiveDocError(err.message || 'Failed to load document');
    } finally {
      setActiveDocLoading(false);
    }
  };

  const handleView = (doc) => {
    openDocumentInPane(doc.id);
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

  const handleDelete = async (doc) => {
    const shouldDelete = await requestConfirmation({
      title: `Delete "${doc.title}"?`,
      description: 'This note will be removed permanently.',
      confirmLabel: 'Delete',
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
      if (!res.ok) throw new Error(data.error || 'Delete failed');

      const removedId = Number(doc.id);
      const nextTotal = Math.max(0, (Number(documentsTotal) || 0) - 1);
      const shouldMoveToPreviousPage = documentsPage > 1 && documents.length <= 1;

      setDocuments((prev) => prev.filter((item) => Number(item.id) !== removedId));
      setDocumentsTotal(nextTotal);
      setSidebarRecentIds((prev) => prev.filter((id) => id !== removedId));
      setSelectedDocumentIds((prev) => prev.filter((id) => Number(id) !== removedId));
      if (activeDoc?.id === doc.id) {
        clearActiveDocShareState();
      }
      setActiveDoc((prev) => (prev?.id === doc.id ? null : prev));
      if (shouldMoveToPreviousPage) {
        setDocumentsPage((prev) => Math.max(1, prev - 1));
      } else {
        await fetchDocuments(documentsPage);
      }
    } catch (err) {
      showToast(err.message || 'Delete failed', 'error');
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
      title: `Delete ${selectedCount} selected note(s)?`,
      description: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!shouldDelete) return;

    await runBulkAction(
      'Delete selected documents',
      async (docId) => {
        const res = await fetch(`/api/documents/${docId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username || '' }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Delete failed');
        return data;
      },
      {
        clearSelectedOnSuccess: true,
        removeRecentOnSuccess: true,
        afterSuccess: (items) => {
          const removedIdSet = new Set(items.map((item) => Number(item.id)));
          if (activeDoc && removedIdSet.has(Number(activeDoc.id))) {
            clearActiveDocShareState();
            setActiveDoc(null);
          }
        },
      }
    );
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
  const docPaneVisible = activeDocLoading || Boolean(activeDocError) || Boolean(activeDoc);

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
    shortcutsOpen,
  ]);

  return (
    <div className="notion-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <aside className="notion-sidebar" aria-label="Left navigation">
        <div
          className={`notion-workspace-picker ${workspaceMenuOpen ? 'open' : ''}`}
          ref={workspaceMenuRef}
        >
          <button
            type="button"
            className="notion-workspace-trigger"
            aria-expanded={workspaceMenuOpen ? 'true' : 'false'}
            aria-controls="workspace-account-menu"
            onClick={() => setWorkspaceMenuOpen((prev) => !prev)}
          >
            <span className="notion-workspace-trigger-main">
              <span className="notion-avatar" aria-hidden="true">
                {workspaceIconLabel(activeWorkspace, accountName)}
              </span>
              <span className="notion-workspace-trigger-label">
                {activeWorkspace?.name || `${accountName}'s Workspace`}
              </span>
            </span>
            <span className="notion-workspace-trigger-chevron" aria-hidden="true">
              ▾
            </span>
          </button>

          <section
            id="workspace-account-menu"
            className="notion-account-panel"
            aria-label="Workspace account"
            hidden={!workspaceMenuOpen}
          >
            <div className="notion-space-head">
              <div className="notion-avatar notion-avatar-large" aria-hidden="true">
                {workspaceIconLabel(activeWorkspace, accountName)}
              </div>
              <div>
                <strong>{activeWorkspace?.name || `${accountName}'s Workspace`}</strong>
                <p>
                  {isLoggedIn
                    ? `${activeWorkspace?.plan || 'Free'} · ${workspaceMemberCount || 1} member${
                        workspaceMemberCount === 1 ? '' : 's'
                      }${
                        pendingRequestCount ? ` · ${pendingRequestCount} pending` : ''
                      }`
                    : 'Guest mode'}
                </p>
              </div>
            </div>

            <div className="notion-account-tools">
              <button
                type="button"
                className="notion-chip-btn"
                onClick={() => {
                  setWorkspaceNameDraft(activeWorkspace?.name || `${accountName}'s Workspace`);
                  setWorkspaceSettingsDraft(normalizeWorkspaceSettings(activeWorkspace?.settings));
                  setWorkspaceSettingsTab('general');
                  setWorkspaceSettingsOpen(true);
                  setWorkspaceInviteOpen(false);
                  setAccountManagerOpen(false);
                  setWorkspaceMenuOpen(false);
                }}
                disabled={
                  !activeWorkspace ||
                  workspaceLoading ||
                  workspaceActionLoading ||
                  (isLoggedIn && activeWorkspace?.is_owner === false)
                }
              >
                Settings
              </button>
              <button
                type="button"
                className="notion-chip-btn"
                onClick={() => {
                  setWorkspaceInviteOpen(true);
                  setWorkspaceSettingsOpen(false);
                  setAccountManagerOpen(false);
                  setInviteCopied(false);
                }}
                disabled={
                  !activeWorkspace ||
                  workspaceLoading ||
                  workspaceActionLoading ||
                  (isLoggedIn &&
                    activeWorkspace?.is_owner === false &&
                    !activeWorkspaceSettings.allow_member_invites)
                }
              >
                Invite Members
              </button>
            </div>

            <div className="notion-account-email-row">
              <span>{accountEmail || 'No email set'}</span>
              <button
                type="button"
                className="notion-ellipsis-btn"
                aria-label="More account actions"
                onClick={() => {
                  setAccountManagerOpen(true);
                  setWorkspaceSettingsOpen(false);
                  setWorkspaceInviteOpen(false);
                  setWorkspaceMenuOpen(false);
                }}
              >
                ...
              </button>
            </div>

            {(workspaceState.workspaces || []).map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                className={`notion-space-switch ${workspace.id === workspaceState.activeWorkspaceId ? 'active' : ''}`}
                onClick={() => handleSelectWorkspace(workspace.id)}
                disabled={workspaceLoading || workspaceActionLoading}
              >
                <span className="notion-space-switch-main">
                  <span className="notion-avatar" aria-hidden="true">
                    {workspaceIconLabel(workspace, workspace.name || accountName)}
                  </span>
                  <span>{workspace.name}</span>
                </span>
                <span aria-hidden="true">{workspace.id === workspaceState.activeWorkspaceId ? '✓' : ''}</span>
              </button>
            ))}

            <button
              type="button"
              className="notion-plus-link"
              onClick={handleCreateWorkspace}
              disabled={workspaceLoading || workspaceActionLoading}
            >
              + New Workspace
            </button>

            <div className="notion-account-divider" />

            <button
              type="button"
              className="notion-account-link"
              onClick={() => {
                setAccountManagerOpen(true);
                setWorkspaceSettingsOpen(false);
                setWorkspaceInviteOpen(false);
                setWorkspaceMenuOpen(false);
              }}
            >
              Add Another Account
            </button>
            <button
              type="button"
              className="notion-account-link"
              onClick={() => {
                if (isLoggedIn) handleSignOut();
                else navigate('/login');
              }}
            >
              {isLoggedIn ? 'Sign Out' : 'Sign In'}
            </button>

            {workspaceInviteOpen && (
              <section className="notion-inline-panel" aria-label="Invite members">
                <h3>Invite Members</h3>
                <label htmlFor="invite-email-input" className="sr-only">
                  Invite email
                </label>
                <input
                  id="invite-email-input"
                  type="text"
                  value={workspaceInviteDraft}
                  onChange={(event) => setWorkspaceInviteDraft(event.target.value)}
                  placeholder="Enter email(s), separated by commas"
                  disabled={workspaceActionLoading}
                />
                <div className="notion-inline-panel-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleInviteMembers}
                    disabled={workspaceActionLoading}
                  >
                    {workspaceActionLoading ? 'Processing...' : 'Create Invite'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={handleCopyInviteLink}
                    disabled={workspaceActionLoading}
                  >
                    {inviteCopied ? 'Link Copied' : 'Copy Invite Link'}
                  </button>
                </div>
                {workspaceInviteLink && (
                  <p className="notion-inline-panel-hint">{workspaceInviteLink}</p>
                )}
                {inviteCount > 0 && (
                  <ul className="notion-inline-list">
                    {inviteItems.map((invite) => {
                      const inviteId = typeof invite === 'object' ? invite?.id || invite?.email : invite;
                      const inviteEmail = typeof invite === 'string' ? invite : invite?.email;
                      const inviteStatus = typeof invite === 'object' ? invite?.status || 'pending' : 'pending';
                      const isRequested = inviteStatus === 'requested';

                      return (
                        <li key={`${inviteId}`}>
                          <span>{inviteEmail}</span>
                          <div className="notion-inline-list-actions">
                            <span className={`notion-invite-status notion-invite-status-${inviteStatus}`}>
                              {inviteStatus === 'requested'
                                ? 'Pending approval'
                                : inviteStatus === 'pending'
                                  ? 'Awaiting request'
                                  : inviteStatus}
                            </span>
                            {isRequested && (
                              <>
                                <button
                                  type="button"
                                  className="notion-inline-list-switch"
                                  onClick={() => handleReviewInvitation(invite, 'approve')}
                                  disabled={workspaceActionLoading}
                                >
                                  Approve
                                </button>
                                <button
                                  type="button"
                                  className="notion-inline-list-remove"
                                  onClick={() => handleReviewInvitation(invite, 'reject')}
                                  disabled={workspaceActionLoading}
                                >
                                  Reject
                                </button>
                              </>
                            )}
                            {!isRequested && (
                              <button
                                type="button"
                                className="notion-inline-list-remove"
                                onClick={() => handleRemoveInvite(invite)}
                                disabled={workspaceActionLoading}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}

          </section>
        </div>

        <nav className="notion-nav" aria-label="Main menu">
          <button
            type="button"
            className={`notion-nav-item ${!showFiles && !showAI && !docPaneVisible ? 'active' : ''}`}
            onClick={() => {
              closeDocumentPane();
              setShowFiles(false);
              setShowAI(false);
            }}
          >
            <span aria-hidden="true">⌂</span>
            <span>Home</span>
          </button>
          <button
            type="button"
            className={`notion-nav-item ${showFiles && !showAI && !docPaneVisible ? 'active' : ''}`}
            onClick={() => {
              closeDocumentPane();
              setShowFiles(true);
              setShowAI(false);
            }}
          >
            <span aria-hidden="true">📄</span>
            <span>My Files</span>
          </button>
          <button
            type="button"
            className={`notion-nav-item ${showAI && !docPaneVisible ? 'active' : ''}`}
            onClick={() => {
              if (!activeWorkspaceSettings.allow_ai_tools) return;
              closeDocumentPane();
              setShowFiles(false);
              setShowAI(true);
            }}
            disabled={!activeWorkspaceSettings.allow_ai_tools}
            title={activeWorkspaceSettings.allow_ai_tools ? undefined : 'AI is disabled in workspace settings'}
          >
            <span aria-hidden="true">✨</span>
            <span>AI Assistant</span>
          </button>
        </nav>

        <section
          className="notion-sidebar-group"
          aria-labelledby="recent-group-title"
          ref={recentMenuRef}
        >
          <h2 id="recent-group-title">Recent</h2>
          <div className="notion-sidebar-list">
            {sidebarDocs.length ? (
              sidebarDocs.map((doc) => (
                <div
                  key={doc.id}
                  className={`notion-sidebar-doc-row ${activeDoc?.id === doc.id ? 'active' : ''} ${sidebarMenuDocId === doc.id ? 'menu-open' : ''}`}
                >
                  <button
                    type="button"
                    className="notion-sidebar-doc"
                    onClick={() => openDocumentInPane(doc.id, { fromSidebar: true })}
                  >
                    <span className="notion-sidebar-doc-prefix" aria-hidden="true">
                      {activeDoc?.id === doc.id ? '›' : '📄'}
                    </span>
                    <span className="notion-sidebar-doc-label">{doc.title}</span>
                  </button>

                  <div className="notion-sidebar-doc-actions">
                    <button
                      type="button"
                      className="notion-sidebar-doc-more"
                      aria-label={`${doc.title} more actions`}
                      aria-expanded={sidebarMenuDocId === doc.id ? 'true' : 'false'}
                      onClick={() =>
                        setSidebarMenuDocId((prev) => (prev === doc.id ? null : doc.id))
                      }
                    >
                      ⋯
                    </button>

                    {sidebarMenuDocId === doc.id && (
                      <a
                        className="notion-sidebar-doc-download"
                        href={`/api/documents/${doc.id}/file${username ? `?username=${encodeURIComponent(username)}` : ''}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => setSidebarMenuDocId(null)}
                      >
                        Download
                      </a>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <span className="notion-sidebar-empty">No recent items</span>
            )}
          </div>
        </section>

      </aside>

      <div className="notion-main">
        <header className="notion-topbar" role="banner">
          <div className="notion-top-left">
            <div className="notion-top-title-group">
              <strong>{activeWorkspace?.name || `${accountName}'s Workspace`}</strong>
              <span className="notion-top-muted">{isLoggedIn ? 'Private workspace' : 'Guest mode'}</span>
            </div>
            <span className="notion-top-time">{nowLabel}</span>
          </div>
          <div className="notion-top-actions">
            <span className="notion-top-pill">{Number(documentsTotal) || 0} Notes</span>
            <span className="notion-top-pill">{dashboardStats.tags} Tags</span>
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
              You are not signed in yet. Uploading, viewing, deleting, and tag editing require sign-in.
            </div>
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
                          Summarize
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
                            Revoke All
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
                            const isActive = status === 'active' && !item?.is_expired;
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
                                    onClick={() => handleRevokeActiveDocShareLink(item)}
                                    disabled={
                                      !isActive ||
                                      loading ||
                                      activeDocShareActionLoadingId === -1
                                    }
                                  >
                                    {loading ? 'Revoking...' : 'Revoke'}
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
            <section className="notion-focus-card" aria-label="Quick entry">
              <div>
                <h2>Study Workspace</h2>
                <p>Upload, categorize, search, and summarize your lecture notes in one place.</p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setShowFiles((prev) => !prev)}
                aria-controls="files-section"
                aria-expanded={showFiles ? 'true' : 'false'}
              >
                {showFiles ? 'Back to Overview' : 'Go to Files'}
              </button>
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
            </section>
          )}

          {!showFiles && !showAI && !docPaneVisible && (
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
                isExtracting={isExtracting}
                isAnalyzing={isAnalyzing}
                extractedText={extractedText}
                onChangeExtractedText={setExtractedText}
                analysisResult={analysisResult}
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

                  <section className="uploader notion-panel-block notion-upload-panel" aria-labelledby="uploader-title">
                    <div className="notion-panel-head">
                      <h2 id="uploader-title" className="section-title">Upload Files</h2>
                      <p>Add new notes to this workspace and auto-index them for search.</p>
                    </div>
                    <div
                      className={`notion-upload-dropzone${dragUploadActive ? ' is-active' : ''}${
                        !activeWorkspaceSettings.allow_uploads ? ' is-disabled' : ''
                      }`}
                      onDragEnter={handleUploadDragEnter}
                      onDragOver={handleUploadDragOver}
                      onDragLeave={handleUploadDragLeave}
                      onDrop={handleUploadDrop}
                    >
                      <form id="upload-form" onSubmit={handleUpload} noValidate>
                        <input
                          id="file-input"
                          type="file"
                          accept=".pdf,.docx,.txt,image/*"
                          ref={fileInputRef}
                          onChange={handleFileChange}
                          className="sr-only"
                          disabled={!activeWorkspaceSettings.allow_uploads}
                        />
                        <label htmlFor="upload-category-input">Category (optional)</label>
                        <input
                          id="upload-category-input"
                          type="text"
                          list="upload-category-options"
                          placeholder="e.g. Computer Science"
                          value={uploadCategory}
                          onChange={(event) => setUploadCategory(event.target.value)}
                          disabled={!activeWorkspaceSettings.allow_uploads}
                        />
                        <datalist id="upload-category-options">
                          {categorySuggestions.map((category) => (
                            <option key={category} value={category} />
                          ))}
                        </datalist>
                        <div className="uploader-actions">
                          <label
                            htmlFor="file-input"
                            className={`btn file-btn${!activeWorkspaceSettings.allow_uploads ? ' disabled' : ''}`}
                            aria-disabled={!activeWorkspaceSettings.allow_uploads}
                          >
                            Choose Files
                          </label>
                          <button
                            id="upload-btn"
                            className="btn btn-primary"
                            type="submit"
                            disabled={!activeWorkspaceSettings.allow_uploads || uploadQueueRunning}
                          >
                            {uploadQueueRunning ? 'Uploading...' : 'Upload'}
                          </button>
                        </div>
                        <span id="file-hint" className="muted file-picker-text" aria-live="polite">
                          {fileHint || 'No file selected yet'}
                        </span>
                        {uploadQueueSummary.total > 0 && (
                          <section className="notion-upload-queue" aria-label="Upload queue">
                            <div className="notion-upload-queue-head">
                              <div className="notion-upload-queue-stats">
                                <span>Total {uploadQueueSummary.total}</span>
                                <span className="is-success">Success {uploadQueueSummary.success}</span>
                                <span className="is-failed">Failed {uploadQueueSummary.failed}</span>
                                <span>Running {uploadQueueSummary.uploading}</span>
                              </div>
                              <div className="notion-upload-queue-actions">
                                <button
                                  type="button"
                                  className="btn"
                                  onClick={() => setUploadQueueExpanded((prev) => !prev)}
                                >
                                  {uploadQueueExpanded ? 'Collapse' : 'Expand'}
                                </button>
                                <button
                                  type="button"
                                  className="btn"
                                  onClick={handleRetryFailedUploads}
                                  disabled={!canRetryFailedUploads}
                                >
                                  Retry Failed
                                </button>
                                <button
                                  type="button"
                                  className="btn"
                                  onClick={handleClearCompletedUploads}
                                  disabled={!canClearUploadQueue}
                                >
                                  Clear Finished
                                </button>
                              </div>
                            </div>
                            {uploadQueueExpanded && (
                              <>
                                <div className="notion-upload-queue-progress" role="presentation">
                                  <span style={{ width: `${uploadQueueSummary.progress}%` }} />
                                </div>
                                <ul className="notion-upload-queue-list">
                                  {uploadQueue.slice(0, 8).map((item) => (
                                    <li key={item.id}>
                                      <div>
                                        <strong>{item.name}</strong>
                                        <span>{item.message || formatFileSize(item.size)}</span>
                                      </div>
                                      <span className={`notion-upload-status notion-upload-status-${item.status}`}>
                                        {item.status}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                                {uploadQueue.length > 8 && (
                                  <p className="muted tiny">
                                    +{uploadQueue.length - 8} more item(s) in queue
                                  </p>
                                )}
                              </>
                            )}
                          </section>
                        )}
                      </form>
                      <p className="notion-upload-drop-hint">
                        Drag & drop files here for quick upload.
                      </p>
                    </div>
                    <p className="muted tiny">
                      {activeWorkspaceSettings.allow_uploads
                        ? 'Supports PDF / DOCX / TXT / images, up to 20MB per file. Empty category will be auto-assigned.'
                        : 'Uploads are currently disabled by workspace settings.'}
                    </p>
                  </section>

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
                        <p>Edit or delete selected notes together.</p>
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
                          className="btn btn-delete"
                          onClick={handleBulkDelete}
                          disabled={bulkActionLoading || documentsLoading || selectAllMatchedLoading}
                        >
                          {bulkActionLoading ? 'Processing...' : 'Delete Selected'}
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
                      onView={handleView}
                      onDelete={handleDelete}
                      onEdit={handleEdit}
                      onEditCategory={handleEditCategory}
                      onSummarize={handleUseDocumentForAI}
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
              Save multiple accounts and switch quickly. Each account keeps a separate workspace state.
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
                          Switch
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
                Save and Switch
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
            sharePolicyPresets={SHARE_POLICY_PRESETS}
            activeSharePolicyPresetId={activeSharePolicyPresetId}
            onClearWorkspaceDocuments={handleClearWorkspaceDocuments}
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
