import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import UiFeedbackLayer from '../components/UiFeedbackLayer.jsx';
import { useUiFeedback } from '../hooks/useUiFeedback.js';
import { coerceOcrText } from '../lib/ocr.js';

const DEFAULT_NOTE_CATEGORY = 'Uncategorized';
const SUMMARY_LENGTH_OPTIONS = new Set(['short', 'medium', 'long']);
const IMAGE_FILE_TYPE_SET = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

const clamp = (value, minValue, maxValue) => Math.min(maxValue, Math.max(minValue, value));
const isImageFileType = (value) => IMAGE_FILE_TYPE_SET.has(String(value || '').toLowerCase());

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
  const [shareLinks, setShareLinks] = useState([]);
  const [shareLinksLoading, setShareLinksLoading] = useState(false);
  const [shareLinksError, setShareLinksError] = useState('');
  const [shareActionLoadingId, setShareActionLoadingId] = useState(0);
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
  const canManageShareLinks = Boolean(document?.canManageShareLinks);
  const canUseAiTools = Boolean(document?.allowAiTools);
  const canUseOcr = canUseAiTools && Boolean(document?.allowOcr);
  const canExportSummary = Boolean(document?.allowExport);

  useEffect(() => {
    const fetchDoc = async () => {
      try {
        const params = new URLSearchParams();
        if (username) params.set('username', username);
        const safeShareToken = String(shareToken || '').trim();
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
        if (!res.ok) throw new Error(payload.error || 'Document not found');
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
      return;
    }
    refreshShareLinks(document.id);
  }, [canManageShareLinks, document?.id, username]);

  if (loading) return <div className="container document-detail"><p>Loading...</p></div>;
  if (error || !document) return <div className="container document-detail"><p>Error: {error}</p></div>;

  const fileParams = new URLSearchParams();
  if (username) fileParams.set('username', username);
  if (shareToken) fileParams.set('share_token', shareToken);
  const fileUrl = `/api/documents/${document.id}/file${fileParams.toString() ? `?${fileParams.toString()}` : ''}`;
  const isImage = isImageFileType(document.fileType);
  
  const headerStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '20px',
    marginBottom: '16px'
  };

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
        throw new Error(data.error || 'Service error');
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
    const link = document.createElement('a');
    link.href = url;
    link.download = `studyhub-summary-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
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
    }
  };

  return (
    <>
      <main className="container document-detail" role="main">
      <button 
        className="btn" 
        type="button" 
        onClick={() => navigate('/', { state: { showFiles: true } })} 
        style={{marginBottom: '20px'}}
      >
        ← Back
      </button>

      <article className="document-detail-card">
        <header style={headerStyle}>
          <div>
            <h1 style={{margin: '0 0 8px'}}>{document.title}</h1>
            <div className="document-meta">Uploaded: {new Date(document.uploadedAt).toLocaleString()}</div>
            <div className="document-meta">Category: {document.category}</div>
            <div className="document-meta">Tags: {document.tags?.length ? document.tags.join(', ') : 'None'}</div>
          </div>
          <div style={{display: 'flex', gap: '8px', flexShrink: 0}}>
            <button
              type="button"
              className="btn"
              onClick={handleCopyShareLink}
              disabled={document.linkSharingMode === 'restricted' || !username || !canManageShareLinks}
            >
              Share Link
            </button>
            <a href={fileUrl} target="_blank" rel="noreferrer" className="btn btn-primary" style={{flexShrink: 0}}>
              Download 
            </a>
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
                  Revoke All
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
                  const isActive = status === 'active' && !item?.is_expired;
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
                          onClick={() => handleRevokeShareLink(item)}
                          disabled={!isActive || loading || shareActionLoadingId === -1}
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
        {username && !canManageShareLinks && (
          <p className="muted tiny">Share link management is owner-only in current workspace settings.</p>
        )}

        <section className="document-body">
          {isImage ? (
            <img src={fileUrl} alt="Preview" style={{maxWidth: '100%', borderRadius: '8px', marginBottom: '16px'}} />
          ) : (
            <>
              <h3 style={{marginTop:0}}>Document Content:</h3>
              <pre style={{whiteSpace: 'pre-wrap', color: '#e9ecf1', fontFamily: 'inherit'}}>
                {document.content || "No text content extracted."}
              </pre>
            </>
          )}

          <section className="notion-ai-section" style={{ marginTop: '20px' }}>
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
                  {isAnalyzing ? 'Summarizing text...' : 'Summarize Text'}
                </button>
                <button
                  type="button"
                  className="btn notion-ai-action-chip"
                  onClick={() => handleAnalyzeText({ forceRefresh: true })}
                  disabled={isAnalyzing || !canUseAiTools}
                  title="Bypass cache and regenerate summary"
                >
                  Rebuild Summary
                </button>
              </div>

              {isImage ? (
                <article className="notion-ai-output">
                  <h3>Text Content</h3>
                  <textarea
                    value={extractedText}
                    onChange={(event) => setExtractedText(event.target.value)}
                    rows={8}
                    style={{ width: '100%' }}
                    placeholder="OCR output will appear here. You can also edit it manually."
                  />
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
