import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import OcrResultModal from '../components/OcrResultModal.jsx';
import FeedbackWidget from '../components/FeedbackWidget.jsx';
import SendNoteByEmailModal from '../components/SendNoteByEmailModal.jsx';
import SummaryResultModal from '../components/SummaryResultModal.jsx';
import UiFeedbackLayer from '../components/UiFeedbackLayer.jsx';
import { useUiFeedback } from '../hooks/useUiFeedback.js';
import { authFetch } from '../lib/authFetch.js';
import { readStoredAuthSession } from '../lib/authSession.js';
import { copyTextToClipboard } from '../lib/clipboard.js';
import { formatDateTimeLabel } from '../lib/dates.js';
import { downloadFileWithAuth } from '../lib/fileDownload.js';
import { coerceOcrText, formatOcrErrorMessage } from '../lib/ocr.js';
import {
  createDocumentShareLink,
  deleteDocumentShareLink,
  deleteInactiveDocumentShareLinks,
  isActiveShareLink,
  listDocumentShareLinks,
  revokeAllDocumentShareLinks,
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

const DEFAULT_NOTE_CATEGORY = 'Uncategorized';
const SUMMARY_LENGTH_OPTIONS = new Set(['short', 'medium', 'long']);
const IMAGE_FILE_TYPE_SET = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
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
const DEFAULT_SUMMARY_PROGRESS = {
  active: false,
  phase: 'idle',
  forceRefresh: false,
  docId: 0,
};

const clamp = (value, minValue, maxValue) => Math.min(maxValue, Math.max(minValue, value));
const isImageFileType = (value) => IMAGE_FILE_TYPE_SET.has(String(value || '').toLowerCase());
const normalizeProcessingStatus = (value) => String(value || '').trim().toLowerCase();
const stripFileExtension = (value) => String(value || '').replace(/\.[a-z0-9]+$/i, '').trim();
const buildOcrNoteTitle = (value) => {
  const base = stripFileExtension(value) || 'Image';
  return `${base} OCR Note`;
};
const normalizeSummaryPayload = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const summary = String(raw.summary || raw.summary_text || '').trim();
  if (!summary) return null;
  return {
    ...raw,
    summary,
    summary_text: String(raw.summary_text || summary).trim(),
    summary_source: String(raw.summary_source || '').trim(),
    summary_model: String(raw.summary_model || raw.summaryModel || '').trim(),
    ai_summary: String(raw.ai_summary || raw.aiSummary || '').trim(),
    extractive_summary: String(raw.extractive_summary || raw.extractiveSummary || '').trim(),
    summary_error: String(raw.summary_error || raw.error || '').trim(),
    used_fallback: Boolean(raw.used_fallback ?? raw.usedFallback),
    key_sentences: Array.isArray(raw.key_sentences) ? raw.key_sentences : [],
  };
};
const summarySourceLabel = (value, usedFallback = false) => {
  const safeValue = String(value || '').trim().toLowerCase();
  if (usedFallback || safeValue === 'textrank_fallback') return 'Extractive fallback';
  if (safeValue === 'textrank_only') return 'TextRank';
  if (safeValue === 'bart_hf') return 'AI summary';
  return safeValue || 'Summary';
};
const getLinkSharingModeLabel = (mode) => {
  const safeMode = String(mode || '').trim().toLowerCase();
  if (safeMode === 'public') return 'Anyone With Link';
  if (safeMode === 'workspace') return 'Workspace Members';
  return 'Restricted';
};

const getShareLinkDisabledReason = ({
  isSharedView = false,
  linkSharingMode = 'workspace',
  username = '',
  canManageShareLinks = false,
}) => {
  if (isSharedView) {
    return 'Share links cannot be created from a shared-document route.';
  }
  if (String(linkSharingMode || '').trim().toLowerCase() === 'restricted') {
    return 'Link sharing is restricted by workspace settings.';
  }
  if (!String(username || '').trim()) {
    return 'Sign in with a workspace account to create share links.';
  }
  if (!canManageShareLinks) {
    return 'Share link creation is owner-only in current workspace access settings.';
  }
  return '';
};

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
    processingStatus: normalizeProcessingStatus(raw.processingStatus ?? raw.processing_status),
    processingError: String(raw.processingError ?? raw.processing_error ?? '').replace(/\s+/g, ' ').trim(),
    processingStartedAt: raw.processingStartedAt ?? raw.processing_started_at ?? '',
    processedAt: raw.processedAt ?? raw.processed_at ?? '',
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
    cachedSummary: normalizeSummaryPayload(raw.cached_summary || raw.cachedSummary),
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
  const location = useLocation();
  const [document, setDocument] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [ocrResultOpen, setOcrResultOpen] = useState(false);
  const [ocrSaveFormat, setOcrSaveFormat] = useState('txt');
  const [ocrSourceDetail, setOcrSourceDetail] = useState('');
  const [extractedText, setExtractedText] = useState('');
  const [analysisResult, setAnalysisResult] = useState(null);
  const [summaryResultOpen, setSummaryResultOpen] = useState(false);
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
  const [sendNoteEmailOpen, setSendNoteEmailOpen] = useState(false);
  const [shareEmailRecipient, setShareEmailRecipient] = useState('');
  const [shareEmailMessage, setShareEmailMessage] = useState('');
  const [shareEmailExpiryDays, setShareEmailExpiryDays] = useState('');
  const [shareEmailResult, setShareEmailResult] = useState(null);
  const [shareModalMode, setShareModalMode] = useState('send');
  const [isSendingShareEmail, setIsSendingShareEmail] = useState(false);
  const summaryProgressTimerRef = useRef(null);
  const {
    toastState,
    confirmDialogState,
    showToast,
    dismissToast,
    requestConfirmation,
    closeConfirmDialog,
  } = useUiFeedback();
  const currentAuthSession = readStoredAuthSession();
  const authToken = currentAuthSession.authToken;
  const username = authToken ? currentAuthSession.username : '';
  const safeShareToken = String(shareToken || '').trim();
  const isSharedView = Boolean(safeShareToken);
  const shouldReturnToMessages = isSharedView && Boolean(
    location.state?.fromMessages || location.state?.returnToMessages
  );
  const sharedReturnMessagesTab = ['friends', 'requests', 'site'].includes(
    String(location.state?.messagesTab || '').trim()
  )
    ? String(location.state?.messagesTab || '').trim()
    : 'site';
  const canManageShareLinks = Boolean(document?.canManageShareLinks);
  const canUseAiTools = Boolean(document?.allowAiTools);
  const canUseOcr = canUseAiTools && Boolean(document?.allowOcr);
  const canExportSummary = Boolean(document?.allowExport);

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
        const res = await authFetch(endpoint, {}, { authToken });
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
        setOcrSourceDetail('');
        setOcrSaveFormat('txt');
        setOcrResultOpen(false);
        setAnalysisResult(data?.cachedSummary || null);
        setSummaryResultOpen(false);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchDoc();
  }, [authToken, docId, shareToken, username]);

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

  const handleBackFromDocument = () => {
    if (shouldReturnToMessages) {
      navigate('/', {
        replace: true,
        state: {
          reopenMessages: true,
          messagesTab: sharedReturnMessagesTab,
        },
      });
      return;
    }
    navigate('/', { state: { showFiles: true } });
  };

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
          <main className="document-share-shell document-detail document-share-page" role="main">
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
                <button type="button" className="btn" onClick={handleBackFromDocument}>
                  {shouldReturnToMessages ? 'Back to Messages' : 'Go Home'}
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

  const previewFileParams = new URLSearchParams();
  if (username) previewFileParams.set('username', username);
  if (shareToken) {
    previewFileParams.set('share_token', shareToken);
  }
  const fileUrl = `/api/documents/${document.id}/file${previewFileParams.toString() ? `?${previewFileParams.toString()}` : ''}`;
  const downloadFileParams = new URLSearchParams();
  if (username) downloadFileParams.set('username', username);
  if (shareToken) downloadFileParams.set('share_token', shareToken);
  const downloadUrl = `/api/documents/${document.id}/file${downloadFileParams.toString() ? `?${downloadFileParams.toString()}` : ''}`;
  const isImage = isImageFileType(document.fileType);
  const isPdf = String(document.fileType || '').toLowerCase() === 'pdf';
  const shareModeLabel = getLinkSharingModeLabel(document.linkSharingMode);
  const shareLinkDisabledReason = getShareLinkDisabledReason({
    isSharedView,
    linkSharingMode: document.linkSharingMode,
    username,
    canManageShareLinks,
  });
  const shareLinkDisabled = Boolean(shareLinkDisabledReason);
  const shareLinkHint = shareLinkDisabled
    ? shareLinkDisabledReason
    : isPdf
      ? 'PDF files support share links here. Creating one copies the new link to your clipboard.'
      : 'Create a share link from this detail page and copy it to your clipboard.';
  const shareDeliveryHint = shareLinkDisabled
    ? shareLinkDisabledReason
    : 'Send a private email with a button that opens this note. Link tools stay secondary.';
  const shareAvailabilityLabel = shareLinkDisabled
    ? (document.linkSharingMode === 'restricted'
      ? 'Sharing blocked'
      : !username
        ? 'Sign-in required'
        : 'Owner-only')
    : 'Share link available';
  const processingMeta = PROCESSING_STATUS_META[document.processingStatus] || null;
  const processingMessage = ['failed', 'text_pending', 'needs_ocr', 'no_text_available', 'action_required'].includes(document.processingStatus)
    ? (document.processingError || processingMeta?.message)
    : processingMeta?.message;
  const summarizeBlockedByProcessing = Boolean(processingMeta);
  const detailMetaPills = [
    document?.fileType ? String(document.fileType).toUpperCase() : 'NOTE',
    document?.category || DEFAULT_NOTE_CATEGORY,
    document?.tags?.length ? `${document.tags.length} tag${document.tags.length === 1 ? '' : 's'}` : 'No tags',
    ...(processingMeta ? [processingMeta.label] : []),
  ];
  const primaryStudyActionLabel = isImage
    ? (isExtracting ? 'Scanning...' : 'Scan Image')
    : (isAnalyzing ? 'Generating...' : 'Generate summary');
  const primaryStudyActionDisabled = isSharedView
    ? true
    : isImage
      ? (isExtracting || !canUseOcr)
      : (isAnalyzing || summarizeBlockedByProcessing || (!extractedText.trim() && !document?.id) || !canUseAiTools);
  const primaryStudyActionTitle = isSharedView
    ? 'Study tools stay in the original workspace view.'
    : isImage
      ? (!canUseAiTools
          ? 'AI tools are disabled in workspace settings.'
          : !canUseOcr
            ? 'OCR is disabled in workspace settings.'
            : 'Extract editable text from this image.')
      : (!canUseAiTools
          ? 'AI tools are disabled in workspace settings.'
          : summarizeBlockedByProcessing
            ? processingMeta.summarizeTitle
          : 'Generate AI summary and key sentences for this note.');
  const readingSurfaceTitle = isImage
    ? 'Image Preview'
    : isPdf
      ? 'Document Text Preview'
      : 'Note Content';
  const readingSurfaceNote = isImage
    ? 'Review the source image here, then use the tools rail for OCR and follow-up actions.'
    : isPdf
      ? 'This is the searchable text StudyHub uses for review, search, and summaries.'
      : 'Read the note first. Review and sharing tools stay in the side rail.';

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
      const items = await listDocumentShareLinks(id, { username });
      setShareLinks(items);
    } catch (err) {
      setShareLinks([]);
      setShareLinksError(err.message || 'Failed to load share links');
    } finally {
      setShareLinksLoading(false);
    }
  };

  const closeSummaryResultModal = () => {
    setSummaryResultOpen(false);
  };

  const closeOcrResultModal = () => {
    setOcrResultOpen(false);
    setOcrSaveFormat('txt');
  };

  const resetShareEmailDraft = () => {
    setShareEmailRecipient('');
    setShareEmailMessage('');
    setShareEmailExpiryDays(String(document?.defaultShareExpiryDays || 7));
  };

  const openSendNoteEmailModal = () => {
    if (shareLinkDisabledReason) {
      showToast(shareLinkDisabledReason, 'warning');
      return;
    }
    resetShareEmailDraft();
    setShareEmailResult(null);
    setShareModalMode('send');
    setSendNoteEmailOpen(true);
  };

  const openShareManager = () => {
    if (shareLinkDisabledReason) {
      showToast(shareLinkDisabledReason, 'warning');
      return;
    }
    resetShareEmailDraft();
    setShareEmailResult(null);
    setShareModalMode('manage');
    setSendNoteEmailOpen(true);
    if (document?.id && username && canManageShareLinks) {
      void refreshShareLinks(document.id);
    }
  };

  const closeSendNoteEmailModal = () => {
    if (isSendingShareEmail) return;
    setSendNoteEmailOpen(false);
    resetShareEmailDraft();
    setShareEmailResult(null);
    setShareModalMode('send');
  };

  const handleSendAnotherShareEmail = () => {
    resetShareEmailDraft();
    setShareEmailResult(null);
    setShareModalMode('send');
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
      const response = await authFetch(endpoint, {
        method: 'POST',
      }, { authToken });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(formatOcrErrorMessage(data));
      }

      const text = coerceOcrText(data?.text ?? data);
      setExtractedText(text);
      setOcrSourceDetail(String(data?.source || '').trim());
      setOcrSaveFormat('txt');
      setOcrResultOpen(true);
      setAnalysisResult(null);
      setSummaryResultOpen(false);
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

      const summaryEndpoint = safeDocId > 0 && !safeText
        ? `/api/documents/${safeDocId}/summarize`
        : '/api/analyze-text';
      const response = await authFetch(summaryEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, { authToken });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(formatSummaryErrorMessage(data));
      }
      setAnalysisResult(normalizeSummaryPayload(data) || data);
      if (data?.cache_hit) {
        showToast('Loaded summary from cache.', 'success');
      } else if (forceRefresh) {
        showToast('Summary regenerated.', 'success');
      } else {
        showToast('Summary is ready.', 'success');
      }
      setSummaryResultOpen(true);
    } catch (err) {
      showToast(`Analysis failed: ${err.message || 'Unknown error'}`, 'error');
    } finally {
      stopSummaryProgress();
      setIsAnalyzing(false);
    }
  };

  const handleCopySummary = async () => {
    if (!canExportSummary) {
      showToast('Export is disabled in this workspace settings.', 'warning');
      return;
    }
    const output = buildSummaryExportText(analysisResult);
    if (!output) return;
    try {
      await copyTextToClipboard(output);
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
    const output = buildSummaryExportText(analysisResult);
    if (!output) return;
    downloadTextFile(buildSummaryExportFilename('txt'), output);
  };

  const handleExportSummaryPdf = async () => {
    if (!canExportSummary) {
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
    if (!canExportSummary) {
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
        title: buildOcrNoteTitle(document?.title),
        file_format: ocrSaveFormat,
      };
      if (shareToken) payload.share_token = shareToken;
      const response = await authFetch(`/api/documents/${document.id}/import-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, { authToken });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save OCR note');
      }
      const savedTitle = String(data?.document?.title || '').trim();
      showToast(
        savedTitle
          ? `OCR text saved as "${savedTitle}".`
          : `OCR text saved as a new ${String(ocrSaveFormat || 'txt').toUpperCase()} note.`,
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
      await downloadFileWithAuth(downloadUrl, {
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
    if (shareLinkDisabledReason) {
      showToast(shareLinkDisabledReason, 'warning');
      return;
    }
    try {
      const { payload, shareUrl } = await createDocumentShareLink(document.id, {
        username,
        expiryDays: document.defaultShareExpiryDays || 7,
      });
      await copyTextToClipboard(shareUrl);
      showToast(
        `Share link copied. Expires in ${payload.expiry_days || document.defaultShareExpiryDays || 7} day(s).`,
        'success'
      );
      await refreshShareLinks(document.id);
    } catch (err) {
      showToast(err.message || 'Failed to create share link.', 'error');
    }
  };

  const handleSendNoteByEmail = async (event) => {
    event?.preventDefault?.();
    if (shareLinkDisabledReason) {
      showToast(shareLinkDisabledReason, 'warning');
      return;
    }
    const recipientEmail = String(shareEmailRecipient || '').trim();
    if (!recipientEmail) {
      showToast('Please enter a recipient email address.', 'warning');
      return;
    }

    setIsSendingShareEmail(true);
    try {
      const payload = await sendDocumentShareLinkEmail(document.id, {
        username,
        recipientEmail,
        message: shareEmailMessage,
        expiryDays: shareEmailExpiryDays,
      });
      await refreshShareLinks(document.id);
      setShareEmailResult(payload);
      setShareModalMode('success');
      showToast(payload.message || `Shared note email sent to ${recipientEmail}.`, 'success');
    } catch (err) {
      showToast(err.message || 'Failed to send note by email.', 'error');
    } finally {
      setIsSendingShareEmail(false);
    }
  };

  const handleCopySentShareLink = async () => {
    const shareUrl = String(shareEmailResult?.share?.share_url || '').trim();
    if (!shareUrl) {
      showToast('No share link was returned for this email.', 'warning');
      return;
    }
    await handleCopyExistingShareLink(shareUrl);
  };

  const handleCopyExistingShareLink = async (shareUrl) => {
    const value = String(shareUrl || '').trim();
    if (!value) {
      showToast('No share link is available to copy.', 'warning');
      return;
    }
    try {
      await copyTextToClipboard(value);
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
      await revokeDocumentShareLink(document.id, shareLinkId, { username });
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
      await deleteDocumentShareLink(document.id, shareLinkId, { username });
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
      const payload = await deleteInactiveDocumentShareLinks(document.id, { username });
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
      const payload = await revokeAllDocumentShareLinks(document.id, { username });
      setShareLinks(Array.isArray(payload.items) ? payload.items : []);
      showToast(`Revoked ${payload.revoked_count || 0} share link(s).`, 'success');
    } catch (err) {
      showToast(err.message || 'Failed to revoke all share links', 'error');
    } finally {
      setShareActionLoadingId(0);
      setShareActionLoadingType('');
    }
  };

  const canShowShareManagement = Boolean(username && canManageShareLinks);
  const shareLinksManagerContent = canShowShareManagement ? (
    <section className="document-detail-share-links-panel" aria-label="Share links management">
      <div className="notion-doc-share-manager-head">
        <div>
          <h3>Manage Links</h3>
          <p className="muted tiny">Advanced access controls stay here so sending remains the default workflow.</p>
        </div>
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
        <p className="muted tiny">No share links yet. Send this note or copy a link to create one.</p>
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
  ) : null;
  const shareEmailExpiryLabel = shareEmailResult?.expires_at
    ? formatDateTimeLabel(shareEmailResult.expires_at)
    : '';

  return (
    <>
      <main
        className={isSharedView
          ? 'document-share-shell document-detail document-share-page'
          : 'container document-detail'}
        role="main"
      >
        <button
          className="btn document-detail-back"
          type="button"
          onClick={handleBackFromDocument}
        >
          {shouldReturnToMessages ? '← Back to Messages' : (isSharedView ? '← Back Home' : '← Back')}
        </button>

        <article className={`document-detail-card${isSharedView ? ' document-detail-card-shared' : ''}`}>
        <header className="document-detail-head">
          <div className="document-detail-hero-copy">
            <span className="document-detail-kicker">{isSharedView ? 'Shared Document' : 'Reading View'}</span>
            <h1>{document.title}</h1>
            <div className="document-detail-meta-pills" aria-label="Document metadata">
              {detailMetaPills.map((item) => (
                <span key={`detail-meta-${item}`} className="document-detail-meta-pill">
                  {item}
                </span>
              ))}
            </div>
            <div className="document-meta document-detail-meta document-detail-meta-subtle">
              Uploaded: {new Date(document.uploadedAt).toLocaleString()}
            </div>
            {processingMeta && (
              <div className={`document-processing-message is-${document.processingStatus}`} role="status">
                {processingMessage}
              </div>
            )}
          </div>
          {isSharedView ? (
            <div className="document-detail-head-side document-share-inline-panel">
              <div className="document-detail-share-status" aria-label="Share status">
                <span className="document-share-pill">{shareModeLabel}</span>
                {document?.share?.isExpired ? (
                  <span className="document-share-pill danger">Expired</span>
                ) : (
                  <span className="document-share-pill success">Active Link</span>
                )}
              </div>
              <div className="document-share-inline-meta">
                <span>Expires</span>
                <strong>{formatDateTimeLabel(document?.share?.expiresAt)}</strong>
              </div>
              <button
                type="button"
                className="btn btn-primary document-share-download-btn"
                onClick={handleDownloadFile}
                disabled={isDownloadingFile}
              >
                {isDownloadingFile ? 'Downloading...' : 'Download Shared File'}
              </button>
            </div>
          ) : (
            <div className="document-detail-head-side">
              <div className="document-detail-primary-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={openSendNoteEmailModal}
                  disabled={shareLinkDisabled}
                  title={shareDeliveryHint}
                >
                  Send
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={handleDownloadFile}
                  disabled={isDownloadingFile}
                >
                  {isDownloadingFile ? 'Exporting...' : 'Export'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={isImage ? handleExtractText : () => handleAnalyzeText()}
                  disabled={primaryStudyActionDisabled}
                  title={primaryStudyActionTitle}
                >
                  {primaryStudyActionLabel}
                </button>
                <details className="document-detail-more-menu">
                  <summary className="btn document-detail-more-trigger">More</summary>
                  <div className="document-detail-more-popover">
                    <button
                      type="button"
                      className="btn"
                      onClick={handleCopyShareLink}
                      disabled={shareLinkDisabled}
                      title={shareLinkHint}
                    >
                      Copy Link
                    </button>
                    {username && canManageShareLinks && (
                      <button
                        type="button"
                        className="btn"
                        onClick={openShareManager}
                        disabled={shareLinkDisabled}
                        title="Review, copy, revoke, or delete existing share links"
                      >
                        Manage Links
                      </button>
                    )}
                    {!isImage && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => handleAnalyzeText({ forceRefresh: true })}
                        disabled={isAnalyzing || !canUseAiTools || summarizeBlockedByProcessing}
                        title={
                          summarizeBlockedByProcessing
                            ? processingMeta.summarizeTitle
                            : 'Bypass cache and refresh document text before summarizing'
                        }
                      >
                        Rebuild Summary
                      </button>
                    )}
                    {isImage && Boolean(extractedText.trim()) && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setOcrResultOpen(true)}
                        disabled={isExtracting}
                      >
                        Open OCR Result
                      </button>
                    )}
                    {analysisResult && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setSummaryResultOpen(true)}
                      >
                        Open Summary Result
                      </button>
                    )}
                  </div>
                </details>
              </div>
              <div className="document-detail-share-status" aria-live="polite">
                <span className="document-share-pill">{shareModeLabel}</span>
                <span className={`document-share-pill${shareLinkDisabled ? ' muted' : ' success'}`}>
                  {shareAvailabilityLabel}
                </span>
              </div>
              <p className="document-detail-share-hint">{shareDeliveryHint}</p>
            </div>
          )}
        </header>
        <div className={`document-detail-layout${isSharedView ? ' document-detail-layout-shared' : ''}`}>
          <section className="document-detail-main">
            <section className="document-body document-detail-reading-panel" aria-labelledby="document-reading-title">
              <div className="document-detail-reading-head">
                <div>
                  <span className="document-detail-reading-kicker">{readingSurfaceTitle}</span>
                  <h3 id="document-reading-title" className="document-detail-section-title">
                    {isImage ? 'Focus on the source image' : 'Focus on the note'}
                  </h3>
                </div>
                <p className="document-detail-reading-note">{readingSurfaceNote}</p>
              </div>
              {isImage ? (
                <div className="document-detail-image-frame">
                  <img src={fileUrl} alt="Preview" className="document-detail-preview-image" />
                </div>
              ) : (
                <pre className="document-detail-pre">
                  {document.content || 'No text content extracted.'}
                </pre>
              )}
            </section>
          </section>

          {!isSharedView && (
            <aside className="document-detail-sidebar" aria-label="Document tools">
              <section className="document-detail-sidebar-card document-detail-info-card">
                <div className="document-detail-sidebar-head">
                  <span className="document-detail-sidebar-kicker">Document Info</span>
                  <strong>At a glance</strong>
                </div>
                <dl className="document-detail-fact-list">
                  <div>
                    <dt>Type</dt>
                    <dd>{document.fileType ? String(document.fileType).toUpperCase() : 'NOTE'}</dd>
                  </div>
                  <div>
                    <dt>Uploaded</dt>
                    <dd>{formatDateTimeLabel(document.uploadedAt)}</dd>
                  </div>
                  <div>
                    <dt>Category</dt>
                    <dd>{document.category}</dd>
                  </div>
                </dl>
                <div className="document-detail-tag-group">
                  <span>Tags</span>
                  <div className="document-detail-tag-list">
                    {document.tags?.length ? (
                      document.tags.map((tag) => (
                        <span key={`detail-tag-${tag}`} className="document-detail-tag-chip">
                          {tag}
                        </span>
                      ))
                    ) : (
                      <span className="document-detail-tag-empty">No tags</span>
                    )}
                  </div>
                </div>
              </section>

              <section className="document-detail-sidebar-card document-detail-study-card">
                <div className="document-detail-sidebar-head">
                  <span className="document-detail-sidebar-kicker">Study Tools</span>
                  <strong>{isImage ? 'OCR and review' : 'Summary and review'}</strong>
                </div>
                {!canUseAiTools ? (
                  <p className="muted tiny">AI tools are disabled in this workspace settings.</p>
                ) : (
                  <>
                    <p className="document-detail-sidebar-note">
                      {isImage
                        ? 'Scan the image to extract editable text, then open the OCR result modal to save or summarize it.'
                        : 'Summaries open in a modal so the note stays central while review actions remain easy to revisit.'}
                    </p>
                    <div className="document-detail-study-actions">
                      {!isImage && (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => handleAnalyzeText({ forceRefresh: true })}
                          disabled={isAnalyzing || !canUseAiTools || summarizeBlockedByProcessing}
                          title={
                            summarizeBlockedByProcessing
                              ? processingMeta.summarizeTitle
                              : 'Bypass cache and refresh document text before summarizing'
                          }
                        >
                          Rebuild Summary
                        </button>
                      )}
                      {isImage && Boolean(extractedText.trim()) && (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setOcrResultOpen(true)}
                          disabled={isExtracting}
                        >
                          Open OCR Result
                        </button>
                      )}
                      {analysisResult && (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setSummaryResultOpen(true)}
                        >
                          Open Summary Result
                        </button>
                      )}
                    </div>
                    {!isImage && analysisResult && (
                      <section className="document-detail-study-aids" aria-label="Study Aids">
                        <div className="document-detail-sidebar-head">
                          <span className="document-detail-sidebar-kicker">Study Aids</span>
                          <strong>{summarySourceLabel(analysisResult.summary_source, analysisResult.used_fallback)}</strong>
                        </div>
                        <article className="notion-ai-output">
                          <h4>AI Summary</h4>
                          {analysisResult.used_fallback && (
                            <span className="document-share-pill muted">Extractive fallback</span>
                          )}
                          <p>{analysisResult.summary || 'No summary available.'}</p>
                        </article>
                        <article className="notion-ai-output">
                          <h4>Key Sentences</h4>
                          <ul>
                            {Array.isArray(analysisResult.key_sentences) && analysisResult.key_sentences.length ? (
                              analysisResult.key_sentences.map((sentence, index) => (
                                <li key={`detail-key-sentence-${index}`}>{sentence}</li>
                              ))
                            ) : (
                              <li>No key sentences available.</li>
                            )}
                          </ul>
                        </article>
                      </section>
                    )}
                  </>
                )}
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
                {isImage && !username && (
                  <p className="muted tiny">Sign in with a workspace account before saving OCR text as a new note.</p>
                )}
                {isImage && extractedText.trim() && (
                  <p className="muted tiny">
                    OCR text is ready{ocrSourceDetail ? ` (${ocrSourceDetail})` : ''}. Open the result modal to edit,
                    save, or summarize it.
                  </p>
                )}
                {!isImage && analysisResult && (
                  <p className="muted tiny">Latest summary is ready. Open the modal anytime to review it again.</p>
                )}
              </section>
            </aside>
          )}
        </div>
      </article>
      </main>
      <SendNoteByEmailModal
        open={sendNoteEmailOpen}
        mode={shareModalMode}
        onClose={closeSendNoteEmailModal}
        onSubmit={handleSendNoteByEmail}
        onSendAnother={handleSendAnotherShareEmail}
        onCopyLink={handleCopySentShareLink}
        onBackToSend={handleSendAnotherShareEmail}
        recipientEmail={shareEmailRecipient}
        onRecipientEmailChange={setShareEmailRecipient}
        message={shareEmailMessage}
        onMessageChange={setShareEmailMessage}
        expiryDays={shareEmailExpiryDays}
        onExpiryDaysChange={setShareEmailExpiryDays}
        isSubmitting={isSendingShareEmail}
        documentTitle={document?.title || document?.filename || 'Untitled Note'}
        linkModeLabel={shareModeLabel}
        successResult={shareEmailResult}
        successExpiryLabel={shareEmailExpiryLabel}
        manageLinksContent={shareLinksManagerContent}
        canManageLinks={canShowShareManagement}
      />
      <SummaryResultModal
        open={summaryResultOpen}
        onClose={closeSummaryResultModal}
        title="Summary Result"
        summaryTitle={document?.title || ''}
        analysisResult={analysisResult}
        onCopySummary={handleCopySummary}
        onExportSummary={handleExportSummary}
        onExportSummaryPdf={handleExportSummaryPdf}
        onEmailSummary={handleEmailSummary}
        allowExport={canExportSummary}
      />
      <OcrResultModal
        open={ocrResultOpen && !summaryResultOpen}
        onClose={closeOcrResultModal}
        sourceLabel={document?.title || ''}
        sourceDetail={ocrSourceDetail}
        extractedText={extractedText}
        onChangeExtractedText={setExtractedText}
        saveFormat={ocrSaveFormat}
        onSaveFormatChange={setOcrSaveFormat}
        onSave={handleSaveOcrResult}
        onSummarize={handleAnalyzeText}
        isExtracting={isExtracting}
        isAnalyzing={isAnalyzing}
        isSaving={isSavingOcr}
        canSave={Boolean(username)}
        canSummarize={!isSharedView && canUseAiTools}
      />
      <UiFeedbackLayer
        toastState={toastState}
        confirmDialogState={confirmDialogState}
        onDismissToast={dismissToast}
        onCloseConfirmDialog={closeConfirmDialog}
      />
      <FeedbackWidget
        enabled={Boolean(username && !isSharedView)}
        workspaceId={document?.workspaceId || ''}
        documentId={document?.id || ''}
      />
    </>
  );
}
