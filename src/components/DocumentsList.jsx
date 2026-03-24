import { useEffect, useMemo, useState } from 'react';
import { fmtDate } from '../lib/dates.js';

const normalizeCategory = (value) => String(value || '').trim() || 'Uncategorized';
const IMAGE_EXT_SET = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

const getDocumentTypeToken = (doc) => {
  const rawType = String(doc?.fileType || doc?.file_type || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '');
  if (rawType && !rawType.includes('/')) return rawType;
  const name = String(doc?.filename || doc?.title || '').toLowerCase();
  const parts = name.split('.');
  return parts.length > 1 ? String(parts.pop() || '').trim() : '';
};

const getDocumentTypeLabel = (doc) => {
  const ext = getDocumentTypeToken(doc);
  if (!ext) return 'FILE';
  if (IMAGE_EXT_SET.has(ext)) return 'IMAGE';
  return ext.toUpperCase();
};

const normalizeSearchTokens = (query) => {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return [];
  const tokens = raw
    .split(/[\s,;|/]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const safe = tokens.length ? tokens : [raw];
  return Array.from(new Set(safe)).slice(0, 8);
};

const mergeRanges = (ranges) => {
  if (!ranges.length) return [];
  const sorted = ranges
    .slice()
    .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
  const merged = [sorted[0]];
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const tail = merged[merged.length - 1];
    if (current.start <= tail.end) {
      tail.end = Math.max(tail.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
};

const renderHighlightedText = (value, tokens) => {
  const source = String(value || '');
  if (!source || !tokens.length) return source;
  const lowerSource = source.toLowerCase();
  const ranges = [];

  tokens.forEach((token) => {
    if (!token) return;
    const needle = String(token).toLowerCase();
    if (!needle) return;
    let cursor = 0;
    while (cursor < lowerSource.length) {
      const matchIndex = lowerSource.indexOf(needle, cursor);
      if (matchIndex < 0) break;
      ranges.push({ start: matchIndex, end: matchIndex + needle.length });
      cursor = matchIndex + Math.max(needle.length, 1);
      if (ranges.length > 36) break;
    }
  });

  const mergedRanges = mergeRanges(ranges);
  if (!mergedRanges.length) return source;

  const output = [];
  let lastCursor = 0;
  mergedRanges.forEach((range, index) => {
    if (range.start > lastCursor) {
      output.push(
        <span key={`text-${index}-${lastCursor}`}>
          {source.slice(lastCursor, range.start)}
        </span>
      );
    }
    output.push(
      <mark key={`mark-${index}-${range.start}`} className="notion-hit-mark">
        {source.slice(range.start, range.end)}
      </mark>
    );
    lastCursor = range.end;
  });
  if (lastCursor < source.length) {
    output.push(<span key={`tail-${lastCursor}`}>{source.slice(lastCursor)}</span>);
  }
  return output;
};

const toSingleLineText = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim();

const buildMatchSnippet = (content, tokens) => {
  const text = toSingleLineText(content);
  if (!text || !tokens.length) return '';

  const lowerText = text.toLowerCase();
  let matchAt = -1;
  let matchLength = 0;

  tokens.forEach((token) => {
    if (!token) return;
    const needle = String(token).toLowerCase();
    const index = lowerText.indexOf(needle);
    if (index >= 0 && (matchAt < 0 || index < matchAt)) {
      matchAt = index;
      matchLength = needle.length;
    }
  });

  if (matchAt < 0) return '';

  const previewBefore = 68;
  const previewAfter = 112;
  const start = Math.max(0, matchAt - previewBefore);
  const end = Math.min(text.length, matchAt + matchLength + previewAfter);
  const preview = text.slice(start, end);
  return `${start > 0 ? '...' : ''}${preview}${end < text.length ? '...' : ''}`;
};

export default function DocumentsList({
  documents,
  isLoggedIn,
  meta,
  canEditMetadata = true,
  canSummarize = true,
  canShare = true,
  starredDocIdSet = new Set(),
  onView,
  onDelete,
  onEdit,
  onEditCategory,
  onSummarize,
  onSummarizeRefresh,
  onToggleStar,
  onShare,
  hasActiveFilters = false,
  onClearFilters,
  selectionEnabled = false,
  selectionDisabled = false,
  selectedDocumentIds = [],
  onToggleDocumentSelection,
  layout = 'grid',
  searchQuery = '',
}) {
  const [openMenuDocId, setOpenMenuDocId] = useState('');
  const searchTokens = useMemo(() => normalizeSearchTokens(searchQuery), [searchQuery]);
  const selectedIdSet = useMemo(
    () =>
      new Set(
        Array.isArray(selectedDocumentIds)
          ? selectedDocumentIds
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id))
          : []
      ),
    [selectedDocumentIds]
  );
  const getSnippetForDoc = (doc) => buildMatchSnippet(doc?.content, searchTokens);

  useEffect(() => {
    setOpenMenuDocId('');
  }, [documents, layout, searchQuery]);

  useEffect(() => {
    const handleMouseDown = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest('[data-doc-menu-root="true"]')) return;
      setOpenMenuDocId('');
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpenMenuDocId('');
      }
    };

    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <>
      <span id="list-meta" className="muted" aria-live="polite">
        {meta}
      </span>
      {documents.length ? (
        <div
          id="documents-container"
          className={`cards ${layout === 'compact' ? 'cards-compact' : 'cards-grid'}`}
          role="list"
        >
          {documents.map((doc) => {
            const matchSnippet = getSnippetForDoc(doc);
            const docMenuId = String(doc.id);
            const isMenuOpen = openMenuDocId === docMenuId;
            const docTags = Array.isArray(doc.tags) ? doc.tags.filter(Boolean) : [];
            const visibleDocTags = docTags.slice(0, 4);
            const hiddenTagCount = Math.max(0, docTags.length - visibleDocTags.length);
            const docTypeLabel = getDocumentTypeLabel(doc);
            const isStarred = starredDocIdSet.has(Number(doc.id));
            return (
              <article key={doc.id} className="document-card" role="listitem">
                <div className="document-card-main">
                  <div className="document-card-head">
                    {selectionEnabled && (
                      <label className="document-select-toggle">
                        <input
                          type="checkbox"
                          checked={selectedIdSet.has(Number(doc.id))}
                          onChange={() => onToggleDocumentSelection?.(doc.id)}
                          disabled={selectionDisabled || !isLoggedIn}
                          aria-label={`Select ${doc.title}`}
                        />
                      </label>
                    )}
                    <h3>{renderHighlightedText(doc.title, searchTokens)}</h3>
                    <button
                      type="button"
                      className={`document-star-toggle${isStarred ? ' active' : ''}`}
                      onClick={() => onToggleStar?.(doc)}
                      title={isStarred ? 'Remove from Starred' : 'Add to Starred'}
                      aria-label={isStarred ? `Remove ${doc.title} from Starred` : `Add ${doc.title} to Starred`}
                    >
                      {isStarred ? '★' : '☆'}
                    </button>
                    <span className="document-type-badge" aria-label={`File type ${docTypeLabel}`}>
                      {docTypeLabel}
                    </span>
                  </div>
                  <div className="document-card-meta-stack">
                    <div className="document-card-meta-inline">
                      <span className="document-meta">Uploaded: {fmtDate(doc.uploadedAt)}</span>
                      <span className="document-meta">
                        Category: {renderHighlightedText(normalizeCategory(doc.category), searchTokens)}
                      </span>
                    </div>
                    <div className="document-tag-list" aria-label="Document tags">
                      {visibleDocTags.length ? (
                        visibleDocTags.map((tag, index) => (
                          <span key={`${doc.id}-tag-${tag}-${index}`} className="document-tag-chip">
                            {renderHighlightedText(tag, searchTokens)}
                          </span>
                        ))
                      ) : (
                        <span className="document-meta">No tags</span>
                      )}
                      {hiddenTagCount > 0 && (
                        <span className="document-tag-overflow" aria-label={`${hiddenTagCount} more tags`}>
                          +{hiddenTagCount}
                        </span>
                      )}
                    </div>
                    {searchTokens.length > 0 && matchSnippet && (
                      <div className="document-match-snippet">
                        <span>Match: </span>
                        {renderHighlightedText(matchSnippet, searchTokens)}
                      </div>
                    )}
                  </div>
                </div>

                <div className="document-card-tools">
                  <button
                    className="btn btn-view document-primary-view"
                    onClick={() => isLoggedIn && onView?.(doc)}
                    title={isLoggedIn ? undefined : 'Please sign in'}
                    disabled={!isLoggedIn}
                    type="button"
                  >
                    View
                  </button>
                  <button
                    className="btn btn-primary document-primary-summarize"
                    onClick={() => isLoggedIn && onSummarize?.(doc)}
                    title={
                      !isLoggedIn
                        ? 'Please sign in'
                        : canSummarize
                          ? 'Summarize this document'
                          : 'AI is disabled in workspace settings'
                    }
                    disabled={!isLoggedIn || !canSummarize}
                    type="button"
                  >
                    Summarize
                  </button>

                  <div
                    className={`document-more-wrap${isMenuOpen ? ' open' : ''}`}
                    data-doc-menu-root="true"
                  >
                    <button
                      type="button"
                      className="btn document-more-trigger"
                      onClick={() =>
                        setOpenMenuDocId((prev) => (prev === docMenuId ? '' : docMenuId))
                      }
                      title="More actions"
                      aria-label={`More actions for ${doc.title}`}
                      aria-haspopup="menu"
                      aria-expanded={isMenuOpen ? 'true' : 'false'}
                      aria-controls={`doc-more-menu-${docMenuId}`}
                    >
                      <span className="document-more-trigger-icon" aria-hidden="true">...</span>
                    </button>
                    {isMenuOpen && (
                      <div
                        id={`doc-more-menu-${docMenuId}`}
                        className="document-more-menu"
                        role="menu"
                      >
                        <div className="document-more-group" role="group" aria-label="Edit options">
                          <p className="document-more-group-title">Edit</p>
                          <button
                            className="document-more-item"
                            onClick={() => {
                              setOpenMenuDocId('');
                              if (isLoggedIn) onEdit?.(doc);
                            }}
                            title={
                              !isLoggedIn
                                ? 'Please sign in'
                                : canEditMetadata
                                  ? undefined
                                  : 'Editing is disabled in workspace settings'
                            }
                            type="button"
                            disabled={!isLoggedIn || !canEditMetadata}
                            role="menuitem"
                          >
                            Edit tags
                          </button>
                          <button
                            className="document-more-item"
                            onClick={() => {
                              setOpenMenuDocId('');
                              if (isLoggedIn) onEditCategory?.(doc);
                            }}
                            title={
                              !isLoggedIn
                                ? 'Please sign in'
                                : canEditMetadata
                                  ? undefined
                                  : 'Editing is disabled in workspace settings'
                            }
                            type="button"
                            disabled={!isLoggedIn || !canEditMetadata}
                            role="menuitem"
                          >
                            Edit category
                          </button>
                        </div>

                        <div className="document-more-separator" role="separator" />

                        <div className="document-more-group" role="group" aria-label="Document actions">
                          <p className="document-more-group-title">Actions</p>
                          <button
                            className="document-more-item"
                            onClick={() => {
                              setOpenMenuDocId('');
                              onToggleStar?.(doc);
                            }}
                            type="button"
                            role="menuitem"
                          >
                            {isStarred ? 'Remove from Starred' : 'Add to Starred'}
                          </button>
                          <button
                            className="document-more-item"
                            onClick={() => {
                              setOpenMenuDocId('');
                              if (isLoggedIn) onSummarize?.(doc);
                            }}
                            title={
                              !isLoggedIn
                                ? 'Please sign in'
                                : canSummarize
                                  ? undefined
                                  : 'AI is disabled in workspace settings'
                            }
                            disabled={!isLoggedIn || !canSummarize}
                            type="button"
                            role="menuitem"
                          >
                            Summarize Document
                          </button>
                          <button
                            className="document-more-item"
                            onClick={() => {
                              setOpenMenuDocId('');
                              if (isLoggedIn) onSummarizeRefresh?.(doc);
                            }}
                            title={
                              !isLoggedIn
                                ? 'Please sign in'
                                : canSummarize
                                  ? 'Bypass cache and refresh document text before summarizing'
                                  : 'AI is disabled in workspace settings'
                            }
                            disabled={!isLoggedIn || !canSummarize}
                            type="button"
                            role="menuitem"
                          >
                            Rebuild (Refresh Text)
                          </button>
                          <button
                            className="document-more-item"
                            onClick={() => {
                              setOpenMenuDocId('');
                              if (isLoggedIn) onShare?.(doc);
                            }}
                            title={
                              !isLoggedIn
                                ? 'Please sign in'
                                : canShare
                                  ? undefined
                                  : 'Link sharing is restricted in workspace settings'
                            }
                            disabled={!isLoggedIn || !canShare}
                            type="button"
                            role="menuitem"
                          >
                            Share
                          </button>
                        </div>

                        <div className="document-more-separator" role="separator" />

                        <div className="document-more-group" role="group" aria-label="Danger actions">
                          <p className="document-more-group-title document-more-group-title-danger">Danger</p>
                          <button
                            className="document-more-item is-danger"
                            onClick={() => {
                              setOpenMenuDocId('');
                              if (isLoggedIn) onDelete?.(doc);
                            }}
                            title={isLoggedIn ? undefined : 'Please sign in'}
                            disabled={!isLoggedIn}
                            type="button"
                            role="menuitem"
                          >
                            Move to Trash
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div id="empty-state" className="empty notion-empty-state">
          <strong>{hasActiveFilters ? 'No matching documents' : 'No documents yet'}</strong>
          <p>
            {hasActiveFilters
              ? 'Try adjusting your search, date range, category, or tag filters.'
              : 'Upload your first note to start building this workspace library.'}
          </p>
          {hasActiveFilters && (
            <div className="notion-empty-actions">
              <button type="button" className="btn" onClick={onClearFilters}>
                Clear All Filters
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
