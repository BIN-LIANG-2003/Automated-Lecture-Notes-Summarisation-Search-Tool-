import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import DocumentsList from '../components/DocumentsList.jsx';
import RichTextEditor from '../components/RichTextEditor.jsx';
import UsageChart from '../components/UsageChart.jsx';
import { todayKey } from '../lib/dates.js';
import { loadUsageMap, persistUsageMap } from '../lib/usage.js';
import { loadAccounts, persistAccounts } from '../lib/accounts.js';
import {
  createWorkspace,
  loadWorkspaceState,
  persistWorkspaceState,
} from '../lib/workspaces.js';

const MAX_SIDEBAR_RECENT = 10;
const MAX_SAVED_ACCOUNTS = 8;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

const normalizeDocument = (doc) => ({
  ...doc,
  uploadedAt: doc.uploaded_at ?? doc.uploadedAt ?? '',
  lastAccessAt: doc.last_access_at ?? doc.lastAccessAt ?? '',
  contentHtml: doc.content_html ?? doc.contentHtml ?? '',
  tags: normalizeTags(doc.tags)
});

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

const PdfInlineViewer = lazy(() => import('../components/PdfInlineViewer.jsx'));

export default function HomePage() {
  const [documents, setDocuments] = useState([]);
  const navigate = useNavigate();
  const location = useLocation();
  const workspaceMenuRef = useRef(null);
  const recentMenuRef = useRef(null);
  const aiImageInputRef = useRef(null);

  const [filters, setFilters] = useState({ query: '', start: '', end: '', tag: '' });
  const [searchDraft, setSearchDraft] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(() => Boolean(sessionStorage.getItem('username')));
  const [showFiles, setShowFiles] = useState(() => location.state?.showFiles || false);
  const [showAI, setShowAI] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [workspaceInviteOpen, setWorkspaceInviteOpen] = useState(false);
  const [accountManagerOpen, setAccountManagerOpen] = useState(false);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceActionLoading, setWorkspaceActionLoading] = useState(false);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState('');
  const [workspaceInviteDraft, setWorkspaceInviteDraft] = useState('');
  const [latestInviteLinks, setLatestInviteLinks] = useState([]);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [accountDraft, setAccountDraft] = useState({ username: '', email: '' });
  const [savedAccounts, setSavedAccounts] = useState(() => normalizeAccounts(loadAccounts()));
  const [workspaceState, setWorkspaceState] = useState(() =>
    loadWorkspaceState(sessionStorage.getItem('username') || '访客')
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
  const [extractedText, setExtractedText] = useState('');
  const [analysisResult, setAnalysisResult] = useState(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const [fileHint, setFileHint] = useState('');
  const fileInputRef = useRef(null);
  const [usageMap, setUsageMap] = useState(() => loadUsageMap());
  const sessionStartRef = useRef(null);
  const [now, setNow] = useState(() => new Date());

  const username = sessionStorage.getItem('username');
  const accountName = username || '访客';
  const accountEmail = sessionStorage.getItem('email') || (username ? `${username}` : '');
  const activeWorkspace = useMemo(() => {
    if (!workspaceState?.workspaces?.length) return null;
    return (
      workspaceState.workspaces.find((item) => item.id === workspaceState.activeWorkspaceId) ||
      workspaceState.workspaces[0]
    );
  }, [workspaceState]);
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
      return nextState;
    }

    setWorkspaceLoading(true);
    try {
      const res = await fetch(`/api/workspaces?username=${encodeURIComponent(username)}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || '加载工作空间失败');

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
      return nextState;
    } catch (err) {
      console.error('Failed to refresh workspaces', err);
      return workspaceState;
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const fetchDocuments = async () => {
    if (!username) {
      setDocuments([]);
      return;
    }
    try {
      const res = await fetch(`/api/documents?username=${username}`);
      if (res.ok) {
        const data = await res.json();
        const normalized = Array.isArray(data) ? data.map(normalizeDocument) : [];
        setDocuments(normalized);
      }
    } catch (err) {
      console.error('Failed to fetch documents', err);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, [username]);

  useEffect(() => {
    setActiveDocEditMode(false);
    setActiveDocSaveError('');
    setActiveDocDraftHtml(getDocumentRichHtml(activeDoc));
  }, [activeDoc?.id, activeDoc?.content, activeDoc?.contentHtml]);

  useEffect(() => {
    if (location.state?.showFiles) {
      setShowFiles(true);
      setShowAI(false);
    }
  }, [location.state]);

  useEffect(() => {
    const handleStorage = () => {
      setIsLoggedIn(Boolean(sessionStorage.getItem('username')));
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
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
        setInviteCopied(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

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

  const filteredDocuments = useMemo(() => {
    const { query, start, end, tag } = filters;
    const lower = query.trim().toLowerCase();
    const startDate = start ? new Date(`${start}T00:00:00`) : null;
    const endDate = end ? new Date(`${end}T23:59:59`) : null;

    return documents.filter((doc) => {
      const matchesQuery = lower
        ? doc.title?.toLowerCase().includes(lower) ||
          (doc.tags || []).some((item) => item.toLowerCase().includes(lower))
        : true;
      const uploaded = new Date(doc.uploadedAt);
      const matchesStart = startDate ? uploaded >= startDate : true;
      const matchesEnd = endDate ? uploaded <= endDate : true;
      const matchesTag = tag ? (doc.tags || []).includes(tag) : true;
      return matchesQuery && matchesStart && matchesEnd && matchesTag;
    });
  }, [documents, filters]);

  const tags = useMemo(() => {
    const bag = new Set();
    documents.forEach((doc) => (doc.tags || []).forEach((tag) => bag.add(tag)));
    return Array.from(bag);
  }, [documents]);

  useEffect(() => {
    // If the selected tag no longer exists after edits, clear stale filter automatically.
    if (!filters.tag) return;
    if (!tags.includes(filters.tag)) {
      setFilters((prev) => ({ ...prev, tag: '' }));
    }
  }, [tags, filters.tag]);

  const formatDisplayDate = (value) => {
    if (!value) return 'YYYY/MM/DD';
    const [year, month, day] = value.split('-');
    return [year, month, day].filter(Boolean).join('/');
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
      const next = [...newlyAdded, ...cleanedPrev].slice(0, MAX_SIDEBAR_RECENT);
      if (next.length === prev.length && next.every((id, idx) => id === prev[idx])) return prev;
      return next;
    });
  }, [sortedUploadIds]);

  const sidebarDocs = useMemo(() => {
    const byId = new Map(documents.map((doc) => [Number(doc.id), doc]));
    return sidebarRecentIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .slice(0, MAX_SIDEBAR_RECENT);
  }, [documents, sidebarRecentIds]);

  const nowLabel = useMemo(
    () =>
      `@今天 ${now.toLocaleTimeString('zh-CN', {
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

  const handleSignOut = ({ forgetCurrent = false } = {}) => {
    const currentUsername = sessionStorage.getItem('username') || '';
    sessionStorage.removeItem('username');
    sessionStorage.removeItem('email');
    sessionStorage.removeItem('loginAt');
    setIsLoggedIn(false);
    setDocuments([]);
    setSidebarRecentIds([]);
    setSidebarMenuDocId(null);
    setActiveDoc(null);
    setActiveDocError('');
    setActiveDocLoading(false);
    setActiveDocFileVersion(0);
    setActiveDocEditMode(false);
    setActiveDocDraftHtml('');
    setActiveDocSaveError('');
    setShowFiles(false);
    setShowAI(false);
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
    sessionStorage.setItem('loginAt', new Date().toISOString());

    setIsLoggedIn(true);
    setDocuments([]);
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
    setShowFiles(false);
    setShowAI(false);
    setSavedAccounts((prev) => upsertAccount(prev, target));
  };

  const handleCreateWorkspace = async () => {
    const proposedName = window.prompt('请输入工作空间名称：', `${accountName} 的工作空间`);
    if (proposedName === null) return;
    const nextName = proposedName.trim() || `${accountName} 的工作空间`;

    if (isLoggedIn && username) {
      setWorkspaceActionLoading(true);
      try {
        const res = await fetch('/api/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, name: nextName }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || '新建工作空间失败');
        await refreshWorkspaces({ preferredWorkspaceId: payload.id, preserveActive: false });
      } catch (err) {
        alert(err.message || '新建工作空间失败');
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
  };

  const handleSelectWorkspace = (workspaceId) => {
    const targetId = String(workspaceId || '');
    if (!targetId) return;
    setWorkspaceState((prev) => {
      if (!prev?.workspaces?.some((item) => item.id === targetId)) return prev;
      return {
        ...prev,
        activeWorkspaceId: targetId,
      };
    });
  };

  const handleSaveWorkspaceSettings = () => {
    if (!activeWorkspace) return;
    const nextName = workspaceNameDraft.trim();
    if (!nextName) {
      alert('工作空间名称不能为空。');
      return;
    }
    if (isLoggedIn && username) {
      setWorkspaceActionLoading(true);
      fetch(`/api/workspaces/${encodeURIComponent(activeWorkspace.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          name: nextName,
        }),
      })
        .then(async (res) => {
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(payload.error || '保存工作空间设置失败');
          await refreshWorkspaces({ preferredWorkspaceId: activeWorkspace.id });
          setWorkspaceSettingsOpen(false);
        })
        .catch((err) => {
          alert(err.message || '保存工作空间设置失败');
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
            }
          : item
      ),
    }));
    setWorkspaceSettingsOpen(false);
  };

  const handleInviteMembers = async () => {
    if (!activeWorkspace) return;
    const candidates = workspaceInviteDraft
      .split(/[,;\n]/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (!candidates.length) {
      alert('请输入至少一个邮箱地址。');
      return;
    }

    const invalidEmails = candidates.filter((email) => !EMAIL_REGEX.test(email));
    if (invalidEmails.length) {
      alert(`以下邮箱格式不正确：${invalidEmails.join(', ')}`);
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
            expiry_days: 7,
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || '创建邀请失败');

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
          alert(`以下邮箱未发送成功（通常是 Resend 配置问题）：${failedEmails.join(', ')}`);
        }
      } catch (err) {
        alert(err.message || '创建邀请失败');
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
        if (!res.ok) throw new Error(payload.error || '移除邀请失败');
        await refreshWorkspaces({ preferredWorkspaceId: activeWorkspace.id });
      } catch (err) {
        alert(err.message || '移除邀请失败');
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
      if (!res.ok) throw new Error(payload.error || '审批失败');
      await refreshWorkspaces({ preferredWorkspaceId: activeWorkspace.id });
    } catch (err) {
      alert(err.message || '审批失败');
    } finally {
      setWorkspaceActionLoading(false);
    }
  };

  const handleCopyInviteLink = async () => {
    if (!workspaceInviteLink) {
      alert('当前没有可复制的邀请链接。');
      return;
    }
    try {
      await navigator.clipboard.writeText(workspaceInviteLink);
      setInviteCopied(true);
    } catch {
      alert('复制失败，请手动复制链接。');
    }
  };

  const handleSaveManualAccount = () => {
    const target = normalizeAccountRecord(accountDraft);
    if (!target) {
      alert('请填写账号名。');
      return;
    }
    if (target.email && !EMAIL_REGEX.test(target.email)) {
      alert('邮箱格式不正确。');
      return;
    }
    setSavedAccounts((prev) => upsertAccount(prev, target));
    setAccountDraft({ username: '', email: '' });
    handleSwitchAccount(target);
  };

  const handleRemoveSavedAccount = (targetUsername) => {
    const target = String(targetUsername || '').trim();
    if (!target) return;
    if (target === username) {
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

  const bumpSidebarRecent = (docId) => {
    const id = Number(docId);
    if (!Number.isFinite(id)) return;
    setSidebarRecentIds((prev) => [id, ...prev.filter((item) => item !== id)].slice(0, MAX_SIDEBAR_RECENT));
  };

  const handleFileChange = (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      setFileHint('');
      return;
    }
    setFileHint(describeFiles(files));
  };

  const handleUpload = async (event) => {
    event.preventDefault();
    if (!isLoggedIn) {
      alert('Please sign in before uploading.');
      return;
    }
    const files = Array.from(fileInputRef.current?.files || []);
    if (!files.length) {
      alert('Please choose at least one file first.');
      return;
    }

    const activeUser = sessionStorage.getItem('username');
    let successCount = 0;

    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('username', activeUser);

      try {
        const response = await fetch('/api/documents/upload', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response.json();
          alert(`Upload failed for ${file.name}: ${errorData.error}`);
        } else {
          successCount += 1;
          await fetchDocuments();
        }
      } catch (error) {
        console.error('Upload error:', error);
        alert(`Network error uploading ${file.name}. Is the backend running?`);
      }
    }

    if (successCount > 0) {
      event.target.reset();
      if (fileInputRef.current) fileInputRef.current.value = '';
      setFileHint('');
      alert(`Upload complete! (${successCount}/${files.length} success)`);
    }
  };

  const handleExtractText = async (imageFile) => {
    if (!imageFile) {
      alert('请先选择一张图片！');
      return;
    }

    setIsExtracting(true);
    const formData = new FormData();
    formData.append('image', imageFile);

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
        const detail = [data?.error, data?.details?.huggingface, data?.details?.local, runtimeHints]
          .filter(Boolean)
          .join(' | ');
        alert(`文字提取失败：${detail || '服务异常'}`);
        return;
      }

      const nextText = typeof data.text === 'string' ? data.text : '';
      setExtractedText(nextText);
      setAnalysisResult(null);
    } catch (error) {
      console.error('Extract text failed:', error);
      alert('文字提取请求失败，请稍后重试。');
    } finally {
      setIsExtracting(false);
    }
  };

  const handleAIImageChange = async (event) => {
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    if (!file) return;
    await handleExtractText(file);
  };

  const openAIImagePicker = () => {
    if (isExtracting) return;
    aiImageInputRef.current?.click();
  };

  const handleAnalyzeText = async () => {
    if (!extractedText.trim()) {
      alert('文本框为空，无法分析！');
      return;
    }

    setIsAnalyzing(true);
    try {
      const response = await fetch('/api/analyze-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: extractedText }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        alert(`分析失败：${data.error || '服务异常'}`);
        return;
      }

      setAnalysisResult(data);
    } catch (error) {
      console.error('Analyze text failed:', error);
      alert('文本分析请求失败，请稍后重试。');
    } finally {
      setIsAnalyzing(false);
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

    if (fromSidebar) {
      // Sidebar click should open the document pane directly, not stay in file-list mode.
      setShowFiles(false);
      setShowAI(false);
      window.requestAnimationFrame(() => {
        document.getElementById('main')?.scrollIntoView({ block: 'start' });
      });
    }
    try {
      const res = await fetch(`/api/documents/${docId}`);
      if (!res.ok) throw new Error('Document not found');
      const data = await res.json();
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

  const handleDelete = async (doc) => {
    if (!window.confirm(`Delete “${doc.title}”?`)) return;
    try {
      const res = await fetch(`/api/documents/${doc.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username || '' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Delete failed');

      setDocuments((prev) => prev.filter((item) => item.id !== doc.id));
      setSidebarRecentIds((prev) => prev.filter((id) => id !== Number(doc.id)));
      setActiveDoc((prev) => (prev?.id === doc.id ? null : prev));
    } catch (err) {
      alert(err.message || '删除失败');
    }
  };

  const handleEdit = async (doc) => {
    const input = window.prompt('Enter tags separated by commas:', (doc.tags || []).join(','));
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
      alert(err.message || '更新标签失败');
    }
  };

  const handleSaveActiveDocContent = async () => {
    if (!activeDoc) return;
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
      setActiveDocSaveError(err.message || '保存文档内容失败');
    } finally {
      setActiveDocSaveLoading(false);
    }
  };

  const handleSaveActivePdfFile = async (pdfBytes) => {
    if (!activeDoc) throw new Error('No active document selected');
    const targetDocId = Number(activeDoc.id);
    setActiveDocSaveLoading(true);
    setActiveDocSaveError('');

    try {
      const payload = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
      const res = await fetch(`/api/documents/${activeDoc.id}/pdf`, {
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
      const message = err.message || '保存 PDF 失败';
      setActiveDocSaveError(message);
      throw err;
    } finally {
      setActiveDocSaveLoading(false);
    }
  };

  const applySearch = () => {
    setFilters((prev) => ({ ...prev, query: searchDraft.trim() }));
  };

  const clearFilters = () => {
    setFilters({ query: '', start: '', end: '', tag: '' });
    setSearchDraft('');
  };

  const activeDocFileUrl = activeDoc
    ? `/uploads/${activeDoc.filename}${activeDocFileVersion ? `?v=${activeDocFileVersion}` : ''}`
    : '';
  const activeDocStreamUrl = activeDoc
    ? `/api/documents/${activeDoc.id}/file${activeDocFileVersion ? `?v=${activeDocFileVersion}` : ''}`
    : '';
  const activeDocExt = activeDoc ? getDocExt(activeDoc) : '';
  const activeDocIsImage = ['jpg', 'jpeg', 'png', 'webp'].includes(activeDocExt);
  const activeDocIsPdf = activeDocExt === 'pdf';
  const activeDocCanEditText = ['txt', 'docx'].includes(activeDocExt);
  const activeDocViewHtml = useMemo(() => getDocumentRichHtml(activeDoc), [activeDoc]);
  const showOuterDocHeader = !activeDocIsPdf;
  const activeDocEditButtonLabel = '编辑内容';
  const activeDocSaveButtonLabel = '保存内容';
  const activeDocEditHint = activeDocExt === 'txt'
    ? 'TXT 原文件只能保存纯文本；样式会保留在系统内的编辑显示中。'
    : '保存后会覆盖原 DOCX，并保留常见文本样式（标题、加粗、斜体、列表、颜色、对齐等）。';
  const docPaneVisible = activeDocLoading || Boolean(activeDocError) || Boolean(activeDoc);

  const closeDocumentPane = () => {
    setActiveDoc(null);
    setActiveDocError('');
    setActiveDocLoading(false);
    setActiveDocFileVersion(0);
    setActiveDocEditMode(false);
    setActiveDocDraftHtml('');
    setActiveDocSaveError('');
  };

  return (
    <div className="notion-shell">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>

      <aside className="notion-sidebar" aria-label="左侧导航">
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
                {accountName.slice(0, 1).toUpperCase()}
              </span>
              <span className="notion-workspace-trigger-label">
                {activeWorkspace?.name || `${accountName} 的工作空间`}
              </span>
            </span>
            <span className="notion-workspace-trigger-chevron" aria-hidden="true">
              ▾
            </span>
          </button>

          <section
            id="workspace-account-menu"
            className="notion-account-panel"
            aria-label="工作空间账户"
            hidden={!workspaceMenuOpen}
          >
            <div className="notion-space-head">
              <div className="notion-avatar notion-avatar-large" aria-hidden="true">
                {accountName.slice(0, 1).toUpperCase()}
              </div>
              <div>
                <strong>{activeWorkspace?.name || `${accountName} 的工作空间`}</strong>
                <p>
                  {isLoggedIn
                    ? `${activeWorkspace?.plan || '免费版'} · ${workspaceMemberCount || 1}位成员${
                        pendingRequestCount ? ` · ${pendingRequestCount}条待确认` : ''
                      }`
                    : '访客模式'}
                </p>
              </div>
            </div>

            <div className="notion-account-tools">
              <button
                type="button"
                className="notion-chip-btn"
                onClick={() => {
                  setWorkspaceNameDraft(activeWorkspace?.name || `${accountName} 的工作空间`);
                  setWorkspaceSettingsOpen(true);
                  setWorkspaceInviteOpen(false);
                  setAccountManagerOpen(false);
                }}
                disabled={
                  !activeWorkspace ||
                  workspaceLoading ||
                  workspaceActionLoading ||
                  (isLoggedIn && activeWorkspace?.is_owner === false)
                }
              >
                设置
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
                  (isLoggedIn && activeWorkspace?.is_owner === false)
                }
              >
                邀请成员
              </button>
            </div>

            <div className="notion-account-email-row">
              <span>{accountEmail || '未设置邮箱'}</span>
              <button
                type="button"
                className="notion-ellipsis-btn"
                aria-label="更多账号操作"
                onClick={() => {
                  setAccountManagerOpen((prev) => !prev);
                  setWorkspaceSettingsOpen(false);
                  setWorkspaceInviteOpen(false);
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
                    {String(workspace.name || accountName).slice(0, 1).toUpperCase()}
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
              + 新建工作空间
            </button>

            <div className="notion-account-divider" />

            <button
              type="button"
              className="notion-account-link"
              onClick={() => {
                setAccountManagerOpen(true);
                setWorkspaceSettingsOpen(false);
                setWorkspaceInviteOpen(false);
              }}
            >
              添加另一个帐号
            </button>
            <button
              type="button"
              className="notion-account-link"
              onClick={() => {
                if (isLoggedIn) handleSignOut();
                else navigate('/login');
              }}
            >
              {isLoggedIn ? '登出' : '登录'}
            </button>

            {workspaceSettingsOpen && (
              <section className="notion-inline-panel" aria-label="工作空间设置">
                <h3>工作空间设置</h3>
                <label htmlFor="workspace-name-input" className="sr-only">
                  工作空间名称
                </label>
                <input
                  id="workspace-name-input"
                  type="text"
                  value={workspaceNameDraft}
                  onChange={(event) => setWorkspaceNameDraft(event.target.value)}
                  placeholder="输入工作空间名称"
                  disabled={workspaceActionLoading}
                />
                <div className="notion-inline-panel-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleSaveWorkspaceSettings}
                    disabled={workspaceActionLoading}
                  >
                    {workspaceActionLoading ? '保存中...' : '保存'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setWorkspaceSettingsOpen(false)}
                    disabled={workspaceActionLoading}
                  >
                    取消
                  </button>
                </div>
              </section>
            )}

            {workspaceInviteOpen && (
              <section className="notion-inline-panel" aria-label="邀请成员">
                <h3>邀请成员</h3>
                <label htmlFor="invite-email-input" className="sr-only">
                  邀请邮箱
                </label>
                <input
                  id="invite-email-input"
                  type="text"
                  value={workspaceInviteDraft}
                  onChange={(event) => setWorkspaceInviteDraft(event.target.value)}
                  placeholder="输入邮箱，多个可用逗号分隔"
                  disabled={workspaceActionLoading}
                />
                <div className="notion-inline-panel-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleInviteMembers}
                    disabled={workspaceActionLoading}
                  >
                    {workspaceActionLoading ? '处理中...' : '添加邀请'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={handleCopyInviteLink}
                    disabled={workspaceActionLoading}
                  >
                    {inviteCopied ? '已复制链接' : '复制邀请链接'}
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
                                ? '待确认'
                                : inviteStatus === 'pending'
                                  ? '待申请'
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
                                  通过
                                </button>
                                <button
                                  type="button"
                                  className="notion-inline-list-remove"
                                  onClick={() => handleReviewInvitation(invite, 'reject')}
                                  disabled={workspaceActionLoading}
                                >
                                  拒绝
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
                                移除
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

            {accountManagerOpen && (
              <section className="notion-inline-panel" aria-label="账号管理">
                <h3>账号管理</h3>
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
                            切换
                          </button>
                          <button
                            type="button"
                            className="notion-inline-list-remove"
                            onClick={() => handleRemoveSavedAccount(account.username)}
                          >
                            删除
                          </button>
                        </div>
                      </li>
                    ))
                  ) : (
                    <li>
                      <span>暂无保存账号</span>
                    </li>
                  )}
                </ul>
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
                    placeholder="账号名"
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
                    placeholder="邮箱（可选）"
                  />
                </div>
                <div className="notion-inline-panel-actions">
                  <button type="button" className="btn btn-primary" onClick={handleSaveManualAccount}>
                    保存并切换
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setWorkspaceMenuOpen(false);
                      closeWorkspaceDialogs();
                      navigate('/login');
                    }}
                  >
                    去登录页添加
                  </button>
                </div>
              </section>
            )}
          </section>
        </div>

        <nav className="notion-nav" aria-label="主菜单">
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
            <span>主页</span>
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
            <span>我的文件</span>
          </button>
          <button
            type="button"
            className={`notion-nav-item ${showAI && !docPaneVisible ? 'active' : ''}`}
            onClick={() => {
              closeDocumentPane();
              setShowFiles(false);
              setShowAI(true);
            }}
          >
            <span aria-hidden="true">✨</span>
            <span>AI助手</span>
          </button>
        </nav>

        <section
          className="notion-sidebar-group"
          aria-labelledby="recent-group-title"
          ref={recentMenuRef}
        >
          <h2 id="recent-group-title">最近</h2>
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
                      aria-label={`${doc.title} 更多操作`}
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
                        href={`/uploads/${doc.filename}`}
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
              <span className="notion-sidebar-empty">暂无最近内容</span>
            )}
          </div>
        </section>

      </aside>

      <div className="notion-main">
        <header className="notion-topbar" role="banner">
          <div className="notion-top-left">
            <strong>{nowLabel}</strong>
            <span className="notion-top-muted">{isLoggedIn ? '私人' : '请先登录'}</span>
          </div>
          <button type="button" className="notion-more-btn" aria-label="更多操作">
            ...
          </button>
        </header>

        <main id="main" className="notion-content" role="main">
          {!isLoggedIn && (
            <div id="login-warning" className="notion-warning" role="alert">
              你还没有登录，上传、查看、删除和编辑标签需要先登录。
            </div>
          )}

          {(activeDocLoading || activeDocError || activeDoc) && (
            <section className="notion-inline-doc" aria-live="polite">
              {activeDocLoading && <p className="muted">正在加载文档内容...</p>}

              {!activeDocLoading && activeDocError && (
                <p className="muted">加载失败: {activeDocError}</p>
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
                          下载文件
                        </a>
                        {activeDocCanEditText && (
                          <button
                            type="button"
                            className="edit-tags"
                            onClick={() => {
                              setActiveDocEditMode((prev) => !prev);
                              setActiveDocSaveError('');
                              setActiveDocDraftHtml(getDocumentRichHtml(activeDoc));
                            }}
                            disabled={activeDocSaveLoading}
                          >
                            {activeDocEditMode ? '取消编辑' : activeDocEditButtonLabel}
                          </button>
                        )}
                        {activeDocCanEditText && activeDocEditMode && (
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={handleSaveActiveDocContent}
                            disabled={activeDocSaveLoading}
                          >
                            {activeDocSaveLoading ? '保存中...' : activeDocSaveButtonLabel}
                          </button>
                        )}
                      </div>
                    </header>
                  )}

                  <section
                    className={`document-body notion-inline-doc-body${activeDocIsPdf ? ' notion-inline-doc-body-pdf' : ''}`}
                  >
                    {activeDocCanEditText && activeDocEditMode ? (
                      <div className="notion-doc-editor">
                        <RichTextEditor
                          value={activeDocDraftHtml}
                          onChange={setActiveDocDraftHtml}
                          disabled={activeDocSaveLoading}
                          placeholder="在这里编辑文档内容..."
                        />
                        <p className="muted tiny">
                          {activeDocEditHint}
                        </p>
                        {activeDocSaveError && (
                          <p className="notion-doc-editor-error" role="alert">
                            保存失败: {activeDocSaveError}
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
                      <Suspense fallback={<p className="muted">正在加载 PDF 预览...</p>}>
                        <PdfInlineViewer
                          src={activeDocStreamUrl}
                          title={activeDoc.title}
                          uploadedAt={activeDoc.uploadedAt}
                          tags={activeDoc.tags}
                          downloadUrl={activeDocFileUrl}
                          editable
                          saveLoading={activeDocSaveLoading}
                          saveError={activeDocSaveError}
                          onClearSaveError={() => setActiveDocSaveError('')}
                          onSaveEditedPdf={handleSaveActivePdfFile}
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
            <section className="notion-focus-card" aria-label="快速入口">
              <div>
                <h2>学习工作台</h2>
                <p>进入文件区进行上传、筛选、编辑与查看。</p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setShowFiles((prev) => !prev)}
                aria-controls="files-section"
                aria-expanded={showFiles ? 'true' : 'false'}
              >
                {showFiles ? '返回概览' : '进入文件区'}
              </button>
            </section>
          )}

          {!showFiles && !showAI && !docPaneVisible && (
            <>
              <UsageChart usageMap={usageMap} />
            </>
          )}

          {showAI && !docPaneVisible && (
            <section id="ai-section" className="notion-ai-section">
              <article className="notion-ai-shell" aria-live="polite">
                <input
                  ref={aiImageInputRef}
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={handleAIImageChange}
                />

                <div className="notion-ai-actions-simple">
                  <button
                    type="button"
                    className="btn notion-ai-action-chip"
                    onClick={openAIImagePicker}
                    disabled={isExtracting}
                  >
                    {isExtracting ? '图像识别中...' : '图像识别'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary notion-ai-action-chip"
                    onClick={handleAnalyzeText}
                    disabled={isAnalyzing || !extractedText.trim()}
                  >
                    {isAnalyzing ? '文本摘要中...' : '文本摘要'}
                  </button>
                </div>

                {(extractedText || analysisResult) && (
                  <section className="notion-ai-results">
                    {extractedText && (
                      <article className="notion-ai-output">
                        <h3>识别结果</h3>
                        <pre>{extractedText}</pre>
                      </article>
                    )}

                    {analysisResult && (
                      <article className="notion-ai-output">
                        <h3>摘要结果</h3>
                        <p>{analysisResult.summary || '暂无摘要结果。'}</p>
                        <h4>关键词</h4>
                        <ul>
                          {(analysisResult.keywords || []).map((keyword, index) => (
                            <li key={`${keyword}-${index}`}>{keyword}</li>
                          ))}
                        </ul>
                      </article>
                    )}
                  </section>
                )}

              </article>
            </section>
          )}

          {showFiles && !docPaneVisible && (
            <section id="files-section" className="files-section notion-files-section">
              <section className="filters" aria-labelledby="filters-title">
                <h2 id="filters-title" className="sr-only">
                  过滤器
                </h2>

                <div className="filter-row">
                  <label htmlFor="search-input" className="sr-only">
                    Search
                  </label>
                  <div className="input-with-icon">
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M21 21l-4.3-4.3m1.3-4.7a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <input
                      id="search-input"
                      type="search"
                      placeholder="按标题或标签搜索"
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
                    搜索
                  </button>

                  <div className="date-group">
                    <label htmlFor="start-date">开始</label>
                    <div className="date-input-wrapper" data-filled={filters.start ? 'true' : 'false'}>
                      <input
                        id="start-date"
                        type="date"
                        lang="en-US"
                        value={filters.start}
                        onChange={(event) =>
                          setFilters((prev) => ({ ...prev, start: event.target.value }))
                        }
                      />
                      <span className="date-faux">{formatDisplayDate(filters.start)}</span>
                    </div>
                    <label htmlFor="end-date">结束</label>
                    <div className="date-input-wrapper" data-filled={filters.end ? 'true' : 'false'}>
                      <input
                        id="end-date"
                        type="date"
                        lang="en-US"
                        value={filters.end}
                        onChange={(event) =>
                          setFilters((prev) => ({ ...prev, end: event.target.value }))
                        }
                      />
                      <span className="date-faux">{formatDisplayDate(filters.end)}</span>
                    </div>
                  </div>

                  <button id="clear-filters" className="btn" type="button" onClick={clearFilters}>
                    清空
                  </button>
                </div>

                <div className="tags-row">
                  <span className="muted">标签:</span>
                  <div id="tags-container" className="tags" role="list" aria-label="Tag filters">
                    {tags.length ? (
                      tags.map((tag) => (
                        <button
                          type="button"
                          key={tag}
                          className={`tag ${filters.tag === tag ? 'selected' : ''}`}
                          role="listitem"
                          onClick={() =>
                            setFilters((prev) => ({
                              ...prev,
                              tag: prev.tag === tag ? '' : tag
                            }))
                          }
                        >
                          {tag}
                        </button>
                      ))
                    ) : (
                      <span className="muted">暂无标签</span>
                    )}
                  </div>
                </div>
              </section>

              <section className="uploader" aria-labelledby="uploader-title">
                <h2 id="uploader-title" className="section-title">
                  上传文件
                </h2>
                <form id="upload-form" onSubmit={handleUpload} noValidate>
                  <input
                    id="file-input"
                    type="file"
                    accept=".pdf,.docx,.txt,image/*"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    className="sr-only"
                  />
                  <div className="uploader-actions">
                    <label htmlFor="file-input" className="btn file-btn">
                      选择文件
                    </label>
                    <button id="upload-btn" className="btn btn-primary" type="submit">
                      上传
                    </button>
                  </div>
                  <span id="file-hint" className="muted file-picker-text" aria-live="polite">
                    {fileHint || '尚未选择文件'}
                  </span>
                </form>
                <p className="muted tiny">
                  支持 PDF / DOCX / TXT / 图片，单文件最大 20MB。
                </p>
              </section>

              <section aria-labelledby="docs-title">
                <div className="list-head">
                  <h2 id="docs-title" className="section-title">
                    我的文档
                  </h2>
                </div>
                <DocumentsList
                  documents={filteredDocuments}
                  isLoggedIn={isLoggedIn}
                  meta={`显示 ${filteredDocuments.length} 条（总计 ${documents.length} 条）`}
                  onView={handleView}
                  onDelete={handleDelete}
                  onEdit={handleEdit}
                />
              </section>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
