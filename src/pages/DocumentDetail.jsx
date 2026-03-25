import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import UiFeedbackLayer from '../components/UiFeedbackLayer.jsx';
import { useUiFeedback } from '../hooks/useUiFeedback.js';
import { downloadFileWithAuth } from '../lib/fileDownload.js';
import { coerceOcrText } from '../lib/ocr.js';
import { buildSummaryDiagnostics, formatSummaryErrorMessage } from '../lib/summaryDiagnostics.js';

const DEFAULT_NOTE_CATEGORY = 'Uncategorized';
const SUMMARY_LENGTH_OPTIONS = new Set(['short', 'medium', 'long']);
const IMAGE_FILE_TYPE_SET = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const DEFAULT_SUMMARY_PROGRESS = {
  active: false,
  phase: 'idle',
  forceRefresh: false,
  docId: 0,
};

const clamp = (value, minValue, maxValue) => Math.min(maxValue, Math.max(minValue, value));
const isImageFileType = (value) => IMAGE_FILE_TYPE_SET.has(String(value || '').toLowerCase());
const getLinkSharingModeLabel = (mode) => {
  const safeMode = String(mode || '').trim().toLowerCase();
  if (safeMode === 'public') return 'Anyone With Link';
  if (safeMode === 'workspace') return 'Workspace Members';
  return 'Restricted';
};
const isActiveShareLink = (item) =>
  String(item?.status || '').trim().toLowerCase() === 'active' && !Boolean(item?.is_expired ?? item?.isExpired);

const normalizeDocument = (raw) => {
  if (!raw || typeof raw !== 'object') return null;

  let tags = [];
  if (Array.isArray(raw.tags)) {
    tags = raw.tags.map((tag) => String(tag).trim()).filter(Boolean);
  } else if (typeof raw.tags === 'string') {
    tags = raw.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return {
    id: raw.id,
    title: raw.title || 'Untitled',
    filename: raw.filename || '',
    content: raw.content || '',
    uploadedAt: raw.uploadedAt ?? raw.uploaded_at ?? '',
    fileType: String(raw.fileType ?? raw.file_type ?? '').toLowerCase(),
    category: String(raw.category || '').trim() || DEFAULT_NOTE_CATEGORY,
    workspaceId: String(raw.workspaceId ?? raw.workspace_id ?? '').trim(),
    linkSharingMode: String(raw.link_sharing_mode || raw.linkSharingMode || 'workspace').toLowerCase(),
    canManageShareLinks: Boolean(raw.can_manage_share_links ?? raw.canManageShareLinks),
    allowAiTools: Boolean(raw.allow_ai_tools ?? raw.allowAiTools ?? true),
    allowOcr: Boolean(raw.allow_ocr ?? raw.allowOcr ?? true),
    allowExport: Boolean(raw.allow_export ?? raw.allowExport ?? true),
    summaryLength: SUMMARY_LENGTH_OPTIONS.has(String(raw.summary_length || raw.summaryLength || '').toLowerCase())
      ? String(raw.summary_length || raw.summaryLength).toLowerCase()
      : 'medium',
    keywordLimit: clamp(Number(raw.keyword_limit ?? raw.keywordLimit) || 5, 3, 12),
    defaultShareExpiryDays: clamp(Number(raw.default_share_expiry_days ?? raw.defaultShareExpiryDays) || 7, 1, 30),
    share:
      raw.share && typeof raw.share === 'object'
        ? {
            token: String(raw.share.token || '').trim(),
            status: String(raw.share.status || '').trim().toLowerCase(),
            shareUrl: String(raw.share.share_url || raw.share.shareUrl || '').trim(),
            expiresAt: raw.share.expires_at ?? raw.share.expiresAt ?? '',
            createdAt: raw.share.created_at ?? raw.share.createdAt ?? '',
            createdBy: String(raw.share.created_by || raw.share.createdBy || '').trim(),
            lastAccessAt: raw.share.last_access_at ?? raw.share.lastAccessAt ?? '',
            isExpired: Boolean(raw.share.is_expired ?? raw.share.isExpired),
            isAccessible: Boolean(raw.share.is_accessible ?? raw.share.isAccessible ?? true),
          }
        : null,
    tags,
  };
};

export default function DocumentDetail() {
  const { docId, shareToken } = useParams();
  const navigate = useNavigate();
  const [document, setDocument] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [extractedText, setExtractedText] = useState('');
  const [analysisResult, setAnalysisResult] = useState(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSavingOcr, setIsSavingOcr] = useState(false);
  const [isDownloadingFile, setIsDownloadingFile] = useState(false);
  const [shareAccessState, setShareAccessState] = useState(null);
  const [summaryProgress, setSummaryProgress] = useState(DEFAULT_SUMMARY_PROGRESS);
  const [shareLinks, setShareLinks] = useState([]);
  const [shareLinksLoading, setShareLinksLoading] = useState(false);
  const [shareLinksError, setShareLinksError] = useState('');
  const [shareActionLoadingId, setShareActionLoadingId] = useState(0);
  const [shareActionLoadingType, setShareActionLoadingType] = useState('');
  const summaryProgressTimerRef = useRef(null);
  const {
    toastState,
    confirmDialogState,
    showToast,
    dismissToast,
    requestConfirmation,
    closeConfirmDialog,
  } = useUiFeedback();
  const authToken = sessionStorage.getItem('auth_token') || '';
  const username = authToken ? (sessionStorage.getItem('username') || '') : '';
  const safeShareToken = String(shareToken || '').trim();
  const isSharedView = Boolean(safeShareToken);
  const canManageShareLinks = Boolean(document?.canManageShareLinks);
  const canUseAiTools = Boolean(document?.allowAiTools);
  const canUseOcr = canUseAiTools && Boolean(document?.allowOcr);
  const canExportSummary = Boolean(document?.allowExport);
  const summaryDiagnostics = buildSummaryDiagnostics(analysisResult);

  useEffect(() => {
    const fetchDoc = async () => {
      try {
        setError(null);
        setShareAccessState(null);
        const params = new URLSearchParams();
        if (username) params.set('username', username);
        let endpoint = '';
        if (safeShareToken) {
          endpoint = params.toString()
            ? `/api/share-links/${encodeURIComponent(safeShareToken)}?${params.toString()}`
            : `/api/share-links/${encodeURIComponent(safeShareToken)}`;
        } else {
          endpoint = params.toString()
            ? `/api/documents/${docId}?${params.toString()}`
            : `/api/documents/${docId}`;
        }
        const res = await fetch(endpoint);
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          const message = payload.error || 'Document not found';
          if (safeShareToken) {
            const lowered = String(message).toLowerCase();
            setShareAccessState({
              statusCode: res.status,
              message,
              requiresSignIn:
                res.status === 401 ||
                lowered.includes('workspace members') ||
                lowered.includes('sign in') ||
                lowered.includes('auth token'),
              isExpired: lowered.includes('expired'),
              isRestricted: lowered.includes('restricted'),
              isMissing:
                res.status === 404 ||
                lowered.includes('not found') ||
                lowered.includes('invalid share'),
            });
          }
          throw new Error(message);
        }
        const data = normalizeDocument(payload);
        setDocument(data);
        setExtractedText(isImageFileType(data?.fileType) ? (data?.content || '') : '');
        setAnalysisResult(null);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchDoc();
  }, [docId, shareToken, username]);

  useEffect(() => {
    if (!document?.id || !username || !canManageShareLinks) {
      setShareLinks([]);
      setShareLinksLoading(false);
      setShareLinksError('');
      setShareActionLoadingId(0);
      setShareActionLoadingType('');
      return;
    }
    refreshShareLinks(document.id);
  }, [canManageShareLinks, document?.id, username]);

  useEffect(() => {
    return () => {
      if (summaryProgressTimerRef.current) {
        window.clearTimeout(summaryProgressTimerRef.current);
        summaryProgressTimerRef.current = null;
      }
    };
  }, []);

  if (loading) return <div className="container document-detail"><p>Loading...</p></div>;
  if (error || !document) {
    if (isSharedView) {
      const shareErrorTitle = shareAccessState?.isExpired
        ? 'This Share Link Has Expired'
        : shareAccessState?.isRestricted
          ? 'This Workspace Does Not Allow Shared Links'
          : shareAccessState?.requiresSignIn
            ? 'This Share Link Needs A Workspace Account'
            : shareAccessState?.isMissing
              ? 'This Share Link Is Invalid'
              : 'Cannot Open This Shared Document';
      return (
        <>
          <main className="container document-detail document-share-page" role="main">
            <section className="document-share-hero document-share-hero-error">
              <span className="document-share-kicker">Shared Document</span>
              <h1>{shareErrorTitle}</h1>
              <p>{shareAccessState?.message || error || 'This shared document could not be opened.'}</p>
              <div className="document-share-actions">
                {shareAccessState?.requiresSignIn && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => navigate('/login', { state: { from: `/shared/${safeShareToken}` } })}
                  >
                    Sign In To Continue
                  </button>
                )}
                <button type="button" className="btn" onClick={() => navigate('/')}>
                  Go Home
                </button>
              </div>
            </section>
          </main>
          <UiFeedbackLayer
            toastState={toastState}
            confirmDialogState={confirmDialogState}
            onDismissToast={dismissToast}
            onCloseConfirmDialog={closeConfirmDialog}
          />
        </>
      );
    }
    return <div className="container document-detail"><p>Error: {error}</p></div>;
  }

  const fileParams = new URLSearchParams();
  if (username) fileParams.set('username', username);
  if (authToken) fileParams.set('auth_token', authToken);
  if (shareToken) fileParams.set('share_token', shareToken);
  const fileUrl = `/api/documents/${document.id}/file${fileParams.toString() ? `?${fileParams.toString()}` : ''}`;
  const isImage = isImageFileType(document.fileType);
  const shareModeLabel = getLinkSharingModeLabel(document.linkSharingMode);
  
  const formatDateTimeLabel = (value) => {
    if (!value) return 'Unknown';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return String(value);
    return dt.toLocaleString();
  };

  const refreshShareLinks = async (targetDocId = document?.id) => {
    const id = Number(targetDocId);
    if (!Number.isFinite(id) || id <= 0 || !username || !canManageShareLinks) {
      setShareLinks([]);
      setShareLinksLoading(false);
      setShareLinksError('');
      setShareActionLoadingId(0);
      setShareActionLoadingType('');
      return;
    }

    setShareLinksLoading(true);
    setShareLinksError('');
    try {
      const params = new URLSearchParams({ username });
      const response = await fetch(`/api/documents/${id}/share-links?${params.toString()}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Failed to load share links');
      setShareLinks(Array.isArray(payload.items) ? payload.items : []);
    } catch (err) {
      setShareLinks([]);
      setShareLinksError(err.message || 'Failed to load share links');
    } finally {
      setShareLinksLoading(false);
    }
  };

  const handleExtractText = async () => {
    if (!canUseAiTools) {
      showToast('AI tools are disabled in this workspace settings.', 'warning');
      return;
    }
    if (!canUseOcr) {
      showToast('OCR is disabled in this workspace settings.', 'warning');
      return;
    }
    setIsExtracting(true);
    try {
      const params = new URLSearchParams();
      if (username) params.set('username', username);
      if (shareToken) params.set('share_token', shareToken);
      const targetDocId = document.id;
      const endpoint = params.toString()
        ? `/api/extract-text/${targetDocId}?${params.toString()}`
        : `/api/extract-text/${targetDocId}`;
      const response = await fetch(endpoint, {
        method: 'POST',
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
        throw new Error(detail || 'Service error');
      }

      const text = coerceOcrText(data?.text ?? data);
      setExtractedText(text);
      setAnalysisResult(null);
      if (!text) {
        const source = String(data?.source || '').trim();
        showToast(
          `OCR finished${source ? ` (${source})` : ''}, but no readable text was returned.`,
          'warning'
        );
      }
    } catch (err) {
      showToast(`Text extraction failed: ${err.message || 'Unknown error'}`, 'error');
    } finally {
      setIsExtracting(false);
    }
  };

  const startSummaryProgress = ({ forceRefresh = false, docId = 0 } = {}) => {
    if (summaryProgressTimerRef.current) {
      window.clearTimeout(summaryProgressTimerRef.current);
      summaryProgressTimerRef.current = null;
    }
    const nextDocId = Number(docId) || 0;
    const shouldRefresh = Boolean(forceRefresh && nextDocId > 0);
    setSummaryProgress({
      active: true,
      phase: shouldRefresh ? 'refreshing' : 'summarizing',
      forceRefresh: shouldRefresh,
      docId: shouldRefresh ? nextDocId : 0,
    });
    if (shouldRefresh) {
      summaryProgressTimerRef.current = window.setTimeout(() => {
        setSummaryProgress((prev) => {
          if (!prev.active) return prev;
          return {
            ...prev,
            phase: 'summarizing',
          };
        });
      }, 1800);
    }
  };

  const stopSummaryProgress = () => {
    if (summaryProgressTimerRef.current) {
      window.clearTimeout(summaryProgressTimerRef.current);
      summaryProgressTimerRef.current = null;
    }
    setSummaryProgress(DEFAULT_SUMMARY_PROGRESS);
  };

  const summaryProgressLabel = !summaryProgress.active
    ? ''
    : summaryProgress.forceRefresh && summaryProgress.phase === 'refreshing'
      ? 'Refreshing PDF text from source file...'
      : summaryProgress.forceRefresh
        ? 'Running full-document chunk summary...'
        : 'Generating summary...';

  const handleAnalyzeText = async (options = {}) => {
    const forceRefresh = Boolean(options?.forceRefresh);
    if (!canUseAiTools) {
      showToast('AI tools are disabled in this workspace settings.', 'warning');
      return;
    }
    const safeText = extractedText.trim();
    const safeDocId = Number(document?.id) || 0;
    if (!safeText && safeDocId <= 0) {
      showToast('The text box is empty. Cannot analyze.', 'warning');
      return;
    }

    startSummaryProgress({
      forceRefresh,
      docId: safeDocId,
    });
    setIsAnalyzing(true);
    try {
      const payload = {
        username: username || '',
        workspace_id: document.workspaceId || '',
        summary_length: document.summaryLength || 'medium',
        keyword_limit: document.keywordLimit || 5,
      };
      if (shareToken) payload.share_token = shareToken;
      if (safeText) payload.text = safeText;
      if (safeDocId > 0) payload.doc_id = safeDocId;
      if (forceRefresh) payload.force_refresh = true;

      const response = await fetch('/api/analyze-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(formatSummaryErrorMessage(data));
      }
      setAnalysisResult(data);
      if (data?.cache_hit) {
        showToast('Loaded summary from cache.', 'success');
      } else if (forceRefresh) {
        showToast('Summary regenerated.', 'success');
      } else {
        showToast('Summary is ready.', 'success');
      }
    } catch (err) {
      showToast(`Analysis failed: ${err.message || 'Unknown error'}`, 'error');
    } finally {
      stopSummaryProgress();
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

  const handleCopySummary = async () => {
    if (!canExportSummary) {
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
    if (!canExportSummary) {
      showToast('Export is disabled in this workspace settings.', 'warning');
      return;
    }
    const output = toSummaryExportText();
    if (!output) return;
    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = `studyhub-summary-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveOcrText = async () => {
    if (!username) {
      showToast('Please sign in to save OCR text as a note.', 'warning');
      return;
    }
    const safeText = extractedText.trim();
    if (!safeText) {
      showToast('There is no OCR text to save yet.', 'warning');
      return;
    }

    setIsSavingOcr(true);
    try {
      const payload = {
        username,
        text: safeText,
        title: `${document?.title || 'Untitled'} OCR Note`,
      };
      if (shareToken) payload.share_token = shareToken;
      const response = await fetch(`/api/documents/${document.id}/import-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save OCR note');
      }
      const savedTitle = String(data?.document?.title || '').trim();
      showToast(
        savedTitle ? `OCR text saved as "${savedTitle}".` : 'OCR text saved as a new note.',
        'success'
      );
    } catch (err) {
      showToast(`Save failed: ${err.message || 'Unknown error'}`, 'error');
    } finally {
      setIsSavingOcr(false);
    }
  };

  const handleDownloadFile = async () => {
    if (isDownloadingFile) return;
    setIsDownloadingFile(true);
    try {
      await downloadFileWithAuth(fileUrl, {
        authToken,
        filename: document?.filename || document?.title || 'document',
      });
    } catch (err) {
      showToast(err.message || 'Download failed.', 'error');
    } finally {
      setIsDownloadingFile(false);
    }
  };

  const handleCopyShareLink = async () => {
    if (document.linkSharingMode === 'restricted') {
      showToast('Link sharing is restricted in this workspace.', 'warning');
      return;
    }
    if (!canManageShareLinks) {
      showToast('Only workspace owner can create share links in current settings.', 'warning');
      return;
    }
    if (!username) {
      showToast('Please sign in to create a share link.', 'warning');
      return;
    }
    try {
      const response = await fetch(`/api/documents/${document.id}/share-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          expiry_days: document.defaultShareExpiryDays || 7,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const activeCount = Number(payload?.active_count);
        const maxCount = Number(payload?.max_active_share_links_per_document);
        if (response.status === 409 && Number.isFinite(activeCount) && Number.isFinite(maxCount)) {
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
        `Share link copied. Expires in ${payload.expiry_days || document.defaultShareExpiryDays || 7} day(s).`,
        'success'
      );
      await refreshShareLinks(document.id);
    } catch (err) {
      showToast(err.message || 'Failed to create share link.', 'error');
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

  const handleRevokeShareLink = async (shareLink) => {
    if (!username || !document?.id || !canManageShareLinks) return;
    const shareLinkId = Number(shareLink?.id);
    if (!Number.isFinite(shareLinkId) || shareLinkId <= 0) return;

    setShareActionLoadingId(shareLinkId);
    setShareActionLoadingType('revoke');
    try {
      const response = await fetch(`/api/documents/${document.id}/share-links/${shareLinkId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Failed to revoke share link');
      await refreshShareLinks(document.id);
    } catch (err) {
      showToast(err.message || 'Failed to revoke share link', 'error');
    } finally {
      setShareActionLoadingId(0);
      setShareActionLoadingType('');
    }
  };

  const handleDeleteShareLink = async (shareLink) => {
    if (!username || !document?.id || !canManageShareLinks) return;
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

    setShareActionLoadingId(shareLinkId);
    setShareActionLoadingType('delete');
    try {
      const response = await fetch(`/api/documents/${document.id}/share-links/${shareLinkId}/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Failed to delete share link');
      await refreshShareLinks(document.id);
      showToast('Share link deleted.', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to delete share link', 'error');
    } finally {
      setShareActionLoadingId(0);
      setShareActionLoadingType('');
    }
  };

  const handleDeleteInactiveShareLinks = async () => {
    if (!username || !document?.id || !canManageShareLinks) return;
    const shouldDelete = await requestConfirmation({
      title: 'Delete all inactive share links?',
      description: 'This permanently removes all expired and revoked share links from the list.',
      confirmLabel: 'Delete All Inactive',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!shouldDelete) return;

    setShareActionLoadingId(-2);
    setShareActionLoadingType('delete-inactive');
    try {
      const response = await fetch(`/api/documents/${document.id}/share-links/inactive`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Failed to delete inactive share links');
      setShareLinks(Array.isArray(payload.items) ? payload.items : []);
      showToast(`Deleted ${payload.deleted_count || 0} inactive share link(s).`, 'success');
    } catch (err) {
      showToast(err.message || 'Failed to delete inactive share links', 'error');
    } finally {
      setShareActionLoadingId(0);
      setShareActionLoadingType('');
    }
  };

  const handleRevokeAllShareLinks = async () => {
    if (!username || !document?.id || !canManageShareLinks) return;
    const shouldRevokeAll = await requestConfirmation({
      title: 'Revoke all share links?',
      description: 'All active links of this document will be revoked immediately.',
      confirmLabel: 'Revoke All',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!shouldRevokeAll) return;

    setShareActionLoadingId(-1);
    setShareActionLoadingType('revoke-all');
    try {
      const response = await fetch(`/api/documents/${document.id}/share-links`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Failed to revoke all share links');
      setShareLinks(Array.isArray(payload.items) ? payload.items : []);
      showToast(`Revoked ${payload.revoked_count || 0} share link(s).`, 'success');
    } catch (err) {
      showToast(err.message || 'Failed to revoke all share links', 'error');
    } finally {
      setShareActionLoadingId(0);
      setShareActionLoadingType('');
    }
  };

  return (
    <>
      <main className="container document-detail" role="main">
      <button 
        className="btn document-detail-back" 
        type="button" 
        onClick={() => navigate('/', { state: { showFiles: true } })} 
      >
        {isSharedView ? '← Back Home' : '← Back'}
      </button>

      {isSharedView && (
        <section className="document-share-hero">
          <div className="document-share-head">
            <div>
              <span className="document-share-kicker">Shared Document</span>
              <h1>Open Shared Note</h1>
              <strong className="document-share-title">{document.title}</strong>
              <p>
                {document.linkSharingMode === 'public'
                  ? 'Anyone with this link can open and download the file.'
                  : 'This file was shared from a workspace. Keep the link private and use it before it expires.'}
              </p>
            </div>
            <div className="document-share-pill-group" aria-label="Share access details">
              <span className="document-share-pill">{shareModeLabel}</span>
              {document?.share?.isExpired ? (
                <span className="document-share-pill danger">Expired</span>
              ) : (
                <span className="document-share-pill success">Active Link</span>
              )}
            </div>
          </div>
          <div className="document-share-meta-grid">
            <div>
              <span>Shared access</span>
              <strong>{shareModeLabel}</strong>
            </div>
            <div>
              <span>Expires</span>
              <strong>{formatDateTimeLabel(document?.share?.expiresAt)}</strong>
            </div>
            <div>
              <span>Last opened</span>
              <strong>{formatDateTimeLabel(document?.share?.lastAccessAt)}</strong>
            </div>
          </div>
          <div className="document-share-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleDownloadFile}
              disabled={isDownloadingFile}
            >
              {isDownloadingFile ? 'Downloading...' : 'Download Shared File'}
            </button>
            {!username && (
              <button
                type="button"
                className="btn"
                onClick={() => navigate('/login', { state: { from: `/shared/${safeShareToken}` } })}
              >
                Sign In For Full Access
              </button>
            )}
          </div>
        </section>
      )}

      <article className="document-detail-card">
        <header className="document-detail-head">
          <div>
            <h1>{document.title}</h1>
            <div className="document-meta document-detail-meta">Uploaded: {new Date(document.uploadedAt).toLocaleString()}</div>
            <div className="document-meta document-detail-meta">Category: {document.category}</div>
            <div className="document-meta document-detail-meta">Tags: {document.tags?.length ? document.tags.join(', ') : 'None'}</div>
          </div>
          <div className="document-detail-head-actions">
            <button
              type="button"
              className="btn"
              onClick={handleCopyShareLink}
              disabled={document.linkSharingMode === 'restricted' || !username || !canManageShareLinks}
            >
              Share Link
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleDownloadFile}
              disabled={isDownloadingFile}
            >
              {isDownloadingFile ? 'Downloading...' : 'Download'}
            </button>
          </div>
        </header>

        {username && canManageShareLinks && (
          <section className="notion-doc-share-manager" aria-label="Document share links">
            <div className="notion-doc-share-manager-head">
              <h3>Share Links</h3>
              <div className="notion-doc-share-actions">
                <button
                  type="button"
                  className="btn btn-delete"
                  onClick={handleRevokeAllShareLinks}
                  disabled={shareLinksLoading || shareActionLoadingId !== 0 || !shareLinks.length}
                >
                  {shareActionLoadingId === -1 ? 'Revoking...' : 'Revoke All'}
                </button>
                <button
                  type="button"
                  className="btn btn-delete"
                  onClick={handleDeleteInactiveShareLinks}
                  disabled={
                    shareLinksLoading ||
                    shareActionLoadingId !== 0 ||
                    !shareLinks.some((item) => !isActiveShareLink(item))
                  }
                >
                  {shareActionLoadingId === -2 ? 'Deleting Inactive...' : 'Delete Inactive'}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => refreshShareLinks(document.id)}
                  disabled={shareLinksLoading || shareActionLoadingId !== 0}
                >
                  Refresh
                </button>
              </div>
            </div>
            {shareLinksError && <p className="muted tiny">Load failed: {shareLinksError}</p>}
            {shareLinksLoading && !shareLinksError && <p className="muted tiny">Loading share links...</p>}
            {!shareLinksLoading && !shareLinksError && !shareLinks.length && (
              <p className="muted tiny">No share links yet. Click "Share Link" to create one.</p>
            )}
            {shareLinks.length > 0 && (
              <ul className="notion-doc-share-list">
                {shareLinks.map((item, index) => {
                  const status = String(item?.status || 'unknown').toLowerCase();
                  const isActive = isActiveShareLink(item);
                  const loading = Number(item?.id) === shareActionLoadingId;
                  return (
                    <li key={`detail-share-${item?.id || item?.token || index}`}>
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
                          onClick={() => (isActive ? handleRevokeShareLink(item) : handleDeleteShareLink(item))}
                          disabled={loading || shareActionLoadingId < 0}
                        >
                          {loading
                            ? (shareActionLoadingType === 'delete' ? 'Deleting...' : 'Revoking...')
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
        {username && !canManageShareLinks && (
          <p className="muted tiny">Share link management is owner-only in current workspace settings.</p>
        )}

        <section className="document-body">
          {isImage ? (
            <img src={fileUrl} alt="Preview" className="document-detail-preview-image" />
          ) : (
            <>
              <h3 className="document-detail-section-title">Document Content:</h3>
              <pre className="document-detail-pre">
                {document.content || "No text content extracted."}
              </pre>
            </>
          )}

          <section className="notion-ai-section document-detail-ai-section">
            <article className="notion-ai-shell">
              {!canUseAiTools && (
                <p className="muted tiny">AI tools are disabled in this workspace settings.</p>
              )}
              <div className="notion-ai-actions-simple">
                {isImage && (
                  <button
                    type="button"
                    className="btn notion-ai-action-chip"
                    onClick={handleExtractText}
                    disabled={isExtracting || !canUseOcr}
                  >
                    {!canUseOcr ? 'OCR Disabled' : isExtracting ? 'Running image OCR...' : 'Image OCR'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-primary notion-ai-action-chip"
                  onClick={handleAnalyzeText}
                  disabled={isAnalyzing || (!extractedText.trim() && !document?.id) || !canUseAiTools}
                >
                  {isAnalyzing ? 'Summarizing document...' : (isImage ? 'Summarize Text' : 'Summarize Document')}
                </button>
                <button
                  type="button"
                  className="btn notion-ai-action-chip"
                  onClick={() => handleAnalyzeText({ forceRefresh: true })}
                  disabled={isAnalyzing || !canUseAiTools}
                  title="Bypass cache and refresh document text before summarizing"
                >
                  Rebuild (Refresh Text)
                </button>
              </div>
              {summaryProgress.active && (
                <div className="notion-summary-progress" aria-live="polite">
                  <div className="notion-summary-progress-head">
                    <strong>{summaryProgressLabel}</strong>
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
                </div>
              )}

              {isImage ? (
                <article className="notion-ai-output">
                  <h3>Text Content</h3>
                  <div className="notion-ai-actions-simple">
                    <button
                      type="button"
                      className="btn notion-ai-action-chip"
                      onClick={handleSaveOcrText}
                      disabled={isSavingOcr || !extractedText.trim() || !username}
                    >
                      {isSavingOcr ? 'Saving note...' : 'Save OCR As Note'}
                    </button>
                  </div>
                  <textarea
                    value={extractedText}
                    onChange={(event) => setExtractedText(event.target.value)}
                    rows={8}
                    style={{ width: '100%' }}
                    placeholder="OCR output will appear here. You can also edit it manually."
                  />
                  <p className="muted tiny">
                    Saving creates a new text note in the same workspace so it can be reopened, edited, and downloaded later.
                  </p>
                  {!username && (
                    <p className="muted tiny">Sign in with a workspace account before saving OCR text as a note.</p>
                  )}
                </article>
              ) : (
                <article className="notion-ai-output">
                  <h3>Text Content</h3>
                  <p className="muted tiny">Summary reads document content on server and only returns the summary result.</p>
                </article>
              )}

              {analysisResult && (
                <article className="notion-ai-output">
                  <h3>Summary</h3>
                  <p>{analysisResult.summary || 'No summary available.'}</p>
                  {!!summaryDiagnostics.length && (
                    <div className="notion-ai-diagnostics" aria-label="Summary diagnostics">
                      {summaryDiagnostics.map((item) => (
                        <div key={item.key} className="notion-ai-diagnostic-item">
                          <span>{item.label}</span>
                          <strong>{item.value}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                  <h4>Keywords</h4>
                  <ul>
                    {(Array.isArray(analysisResult.keywords) ? analysisResult.keywords : []).map((keyword, index) => (
                      <li key={`${keyword}-${index}`}>{keyword}</li>
                    ))}
                  </ul>
                  <h4>Key Sentences</h4>
                  <ul>
                    {(Array.isArray(analysisResult.key_sentences) ? analysisResult.key_sentences : []).map((sentence, index) => (
                      <li key={`sentence-${index}`}>{sentence}</li>
                    ))}
                  </ul>
                  <div className="notion-ai-export-actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={handleCopySummary}
                      disabled={!canExportSummary}
                    >
                      Copy Summary
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={handleExportSummary}
                      disabled={!canExportSummary}
                    >
                      Export TXT
                    </button>
                  </div>
                </article>
              )}
            </article>
          </section>
        </section>
      </article>
      </main>
      <UiFeedbackLayer
        toastState={toastState}
        confirmDialogState={confirmDialogState}
        onDismissToast={dismissToast}
        onCloseConfirmDialog={closeConfirmDialog}
      />
    </>
  );
}
