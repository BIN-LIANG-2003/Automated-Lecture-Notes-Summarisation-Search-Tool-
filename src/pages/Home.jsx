import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import DocumentsList from '../components/DocumentsList.jsx';
import RichTextEditor from '../components/RichTextEditor.jsx';
import UsageChart from '../components/UsageChart.jsx';
import { todayKey } from '../lib/dates.js';
import { loadUsageMap, persistUsageMap } from '../lib/usage.js';

const MAX_SIDEBAR_RECENT = 10;

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
  const accountEmail = sessionStorage.getItem('email') || (username ? `${username}` : '未登录');

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
    const handleStorage = () => setIsLoggedIn(Boolean(sessionStorage.getItem('username')));
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

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

  const handleSignOut = () => {
    sessionStorage.clear();
    localStorage.clear();
    setIsLoggedIn(false);
    setDocuments([]);
    window.location.reload();
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
        const detail = [data?.error, data?.details?.huggingface, data?.details?.local].filter(Boolean).join(' | ');
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

  const handleDelete = (doc) => {
    if (!window.confirm(`Delete “${doc.title}”?`)) return;
    setDocuments((prev) => prev.filter((item) => item.id !== doc.id));
    setActiveDoc((prev) => (prev?.id === doc.id ? null : prev));
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
              <span className="notion-workspace-trigger-label">{accountName} 的工作空间</span>
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
                <strong>{accountName} 的工作空间</strong>
                <p>{isLoggedIn ? '免费版 · 1位成员' : '访客模式'}</p>
              </div>
            </div>

            <div className="notion-account-tools">
              <button type="button" className="notion-chip-btn">
                设置
              </button>
              <button type="button" className="notion-chip-btn">
                邀请成员
              </button>
            </div>

            <div className="notion-account-email-row">
              <span>{accountEmail}</span>
              <button type="button" className="notion-ellipsis-btn" aria-label="更多账号操作">
                ...
              </button>
            </div>

            <button type="button" className="notion-space-switch">
              <span className="notion-space-switch-main">
                <span className="notion-avatar" aria-hidden="true">
                  {accountName.slice(0, 1).toUpperCase()}
                </span>
                <span>{accountName} 的工作空间</span>
              </span>
              <span aria-hidden="true">✓</span>
            </button>

            <button type="button" className="notion-plus-link">
              + 新建工作空间
            </button>

            <div className="notion-account-divider" />

            <button type="button" className="notion-account-link">
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
