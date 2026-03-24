const getSummarySourceClassName = (value) => {
  const next = String(value || '').trim().toLowerCase();
  return next || 'fallback';
};

const hasPositiveDocId = (value) => {
  const next = Number(value);
  return Number.isFinite(next) && next > 0;
};

export default function SummaryCenterModal({
  open,
  onClose,
  summaryHistory,
  summaryHistoryStats,
  summaryProgress,
  summaryProgressLabel,
  query,
  onQueryChange,
  source,
  onSourceChange,
  sort,
  onSortChange,
  model,
  onModelChange,
  chunk,
  onChunkChange,
  sourceOptions,
  sortOptions,
  chunkOptions,
  modelOptions,
  items,
  expandedIds,
  actionId,
  onExportTxt,
  onExportJson,
  onClearAll,
  onApplyItem,
  onOpenItemDocument,
  onRebuildItem,
  onToggleExpanded,
  onDeleteItem,
  getSummarySourceLabel,
  formatDateTimeLabel,
}) {
  if (!open) return null;

  return (
    <div className="notion-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="notion-modal-card notion-summary-center-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="summary-center-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="notion-summary-center-head">
          <div>
            <h3 id="summary-center-title">Document Summary Center</h3>
            <p className="notion-settings-help">
              Summaries generated from uploaded PDF / DOCX / TXT content in this workspace.
            </p>
          </div>
          <div className="notion-summary-center-head-actions">
            <span className="notion-top-pill">{summaryHistory.length} saved</span>
            <button
              type="button"
              className="notion-modal-close"
              onClick={onClose}
              aria-label="Close Summary Center"
            >
              ×
            </button>
          </div>
        </div>
        <div className="notion-summary-center-stats" aria-label="Summary statistics">
          <span className="notion-summary-center-stat">
            <strong>{summaryHistoryStats.total}</strong>
            <small>Total</small>
          </span>
          <span className="notion-summary-center-stat is-cache">
            <strong>{summaryHistoryStats.cache}</strong>
            <small>Cache Hits</small>
          </span>
          <span className="notion-summary-center-stat is-ai">
            <strong>{summaryHistoryStats.huggingface}</strong>
            <small>AI Generated</small>
          </span>
          <span className="notion-summary-center-stat is-fallback">
            <strong>{summaryHistoryStats.fallback}</strong>
            <small>Fallback</small>
          </span>
        </div>
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
        <div className="notion-summary-center-toolbar">
          <div className="notion-summary-center-search">
            <input
              type="text"
              placeholder="Search summaries by title, keyword, or content"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              autoFocus
            />
          </div>
          <div className="notion-summary-center-filters">
            <label htmlFor="summary-center-source-select">
              <span>Source</span>
              <select
                id="summary-center-source-select"
                value={source}
                onChange={(event) => onSourceChange(event.target.value)}
              >
                {sourceOptions.map((item) => (
                  <option key={`summary-source-${item.value}`} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="summary-center-sort-select">
              <span>Sort</span>
              <select
                id="summary-center-sort-select"
                value={sort}
                onChange={(event) => onSortChange(event.target.value)}
              >
                {sortOptions.map((item) => (
                  <option key={`summary-sort-${item.value}`} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="summary-center-model-select">
              <span>Model</span>
              <select
                id="summary-center-model-select"
                value={model}
                onChange={(event) => onModelChange(event.target.value)}
              >
                {modelOptions.map((item) => (
                  <option key={`summary-model-${item}`} value={item}>
                    {item === 'all' ? 'All models' : item}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="summary-center-chunk-select">
              <span>Chunking</span>
              <select
                id="summary-center-chunk-select"
                value={chunk}
                onChange={(event) => onChunkChange(event.target.value)}
              >
                {chunkOptions.map((item) => (
                  <option key={`summary-chunk-${item.value}`} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="notion-summary-center-actions">
          <button type="button" className="btn" onClick={onExportTxt} disabled={!items.length}>
            Export TXT
          </button>
          <button type="button" className="btn" onClick={onExportJson} disabled={!items.length}>
            Export JSON
          </button>
          <button type="button" className="btn" onClick={onClearAll} disabled={!summaryHistory.length}>
            Clear All
          </button>
        </div>
        <p className="muted tiny">
          Showing {items.length} of {summaryHistory.length} summaries
        </p>
        {items.length ? (
          <ul className="notion-summary-history-list">
            {items.map((entry) => {
              const expanded = expandedIds.includes(String(entry.id));
              const hasDocument = hasPositiveDocId(entry.docId);
              return (
                <li
                  key={entry.id}
                  className={`notion-summary-history-item is-source-${getSummarySourceClassName(entry.summarySource)}`}
                >
                  <div className="notion-summary-history-meta">
                    <strong>{entry.title}</strong>
                    <span>
                      {(entry.fileType || 'text').toUpperCase()} · {formatDateTimeLabel(entry.generatedAt)} ·{' '}
                      {getSummarySourceLabel(entry.summarySource)} · {entry.chunkCount || 1} chunk
                      {(entry.chunkCount || 1) > 1 ? 's' : ''}
                      {entry.mergeRounds ? ` · merge ${entry.mergeRounds}` : ''}
                      {entry.refreshedFromFile ? ' · refreshed text' : ''}
                    </span>
                  </div>
                  <p className={`notion-summary-history-text ${expanded ? 'is-expanded' : ''}`}>
                    {entry.summary}
                  </p>
                  {entry.summaryNote && <p className="muted tiny">{entry.summaryNote}</p>}
                  {entry.keywords.length > 0 && (
                    <div className="notion-summary-history-tags">
                      {entry.keywords.slice(0, 10).map((keyword) => (
                        <span key={`${entry.id}-${keyword}`}>{keyword}</span>
                      ))}
                    </div>
                  )}
                  <div className="notion-summary-history-actions">
                    <button type="button" className="btn btn-primary" onClick={() => onApplyItem(entry)}>
                      Use in AI Panel
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => onOpenItemDocument(entry)}
                      disabled={!hasDocument}
                    >
                      Open Note
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => onRebuildItem(entry)}
                      disabled={actionId === String(entry.id)}
                      title="Bypass cache and refresh document text before summarizing"
                    >
                      {actionId === String(entry.id) ? 'Rebuilding...' : 'Rebuild + Refresh'}
                    </button>
                    <button type="button" className="btn" onClick={() => onToggleExpanded(entry.id)}>
                      {expanded ? 'Collapse' : 'Expand'}
                    </button>
                    <button type="button" className="btn" onClick={() => onDeleteItem(entry.id)}>
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">No summary history yet. Use "Summarize Document" on any note to generate one.</p>
        )}
        <div className="notion-modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </section>
    </div>
  );
}
