const toPositiveId = (value) => {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return 0;
  return Math.floor(next);
};

export default function TrashModal({
  open,
  onClose,
  trashRetentionDays,
  trashTotal,
  selectedTrashCount,
  trashQuery,
  onTrashQueryChange,
  trashSort,
  onTrashSortChange,
  trashSortOptions,
  trashPageSize,
  onTrashPageSizeChange,
  trashPageSizeOptions,
  onRefresh,
  trashLoading,
  trashActionLoadingId,
  trashBulkActionLoading,
  trashRangeStart,
  trashRangeEnd,
  trashItems,
  allTrashItemsSelectedOnPage,
  onToggleSelectAllOnPage,
  onClearSelection,
  onBulkRestore,
  onBulkDeleteForever,
  trashPurgedCount,
  trashLoadError,
  selectedIdSet,
  onToggleTrashDocumentSelection,
  onRestoreFromTrash,
  onDeleteForeverFromTrash,
  trashPage,
  trashPageCount,
  onPreviousPage,
  onNextPage,
  getDocExt,
  normalizeCategory,
  formatDateTimeLabel,
}) {
  if (!open) return null;

  return (
    <div className="notion-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="notion-modal-card notion-trash-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trash-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="notion-trash-head">
          <div>
            <h3 id="trash-modal-title">Trash</h3>
            <p className="notion-settings-help">
              Notes in Trash are auto-deleted after {trashRetentionDays} day(s).
            </p>
          </div>
          <div className="notion-trash-head-actions">
            <span className="notion-summary-chip">Items {trashTotal}</span>
            {!!selectedTrashCount && (
              <span className="notion-summary-chip is-selected">Selected {selectedTrashCount}</span>
            )}
          </div>
        </div>

        <div className="notion-trash-toolbar">
          <label className="notion-results-control notion-trash-search-control" htmlFor="trash-search-input">
            <span>Search Trash</span>
            <input
              id="trash-search-input"
              type="text"
              placeholder="Search title, tags, category..."
              value={trashQuery}
              onChange={(event) => onTrashQueryChange(event.target.value)}
            />
          </label>
          <label className="notion-results-control" htmlFor="trash-sort-select">
            <span>Sort</span>
            <select
              id="trash-sort-select"
              value={trashSort}
              onChange={(event) => onTrashSortChange(event.target.value)}
            >
              {trashSortOptions.map((item) => (
                <option key={`trash-sort-${item.value}`} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="notion-results-control" htmlFor="trash-page-size-select">
            <span>Per page</span>
            <select
              id="trash-page-size-select"
              value={trashPageSize}
              onChange={(event) => onTrashPageSizeChange(event.target.value)}
            >
              {trashPageSizeOptions.map((size) => (
                <option key={`trash-page-size-${size}`} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            onClick={onRefresh}
            disabled={trashLoading || Boolean(trashActionLoadingId) || trashBulkActionLoading}
          >
            {trashLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        <p className="muted tiny">
          Showing {trashRangeStart}-{trashRangeEnd} of {trashTotal} item(s)
          {trashQuery.trim() ? ` for "${trashQuery.trim()}"` : ''}.
        </p>

        {!!trashItems.length && (
          <div className="notion-trash-bulk-actions">
            <div className="notion-trash-bulk-buttons">
              <button
                type="button"
                className="btn"
                onClick={onToggleSelectAllOnPage}
                disabled={trashLoading || Boolean(trashActionLoadingId) || trashBulkActionLoading}
              >
                {allTrashItemsSelectedOnPage ? 'Unselect Page' : 'Select Page'}
              </button>
              {!!selectedTrashCount && (
                <button
                  type="button"
                  className="btn"
                  onClick={onClearSelection}
                  disabled={trashLoading || Boolean(trashActionLoadingId) || trashBulkActionLoading}
                >
                  Clear Selection
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary"
                onClick={onBulkRestore}
                disabled={
                  !selectedTrashCount ||
                  trashLoading ||
                  Boolean(trashActionLoadingId) ||
                  trashBulkActionLoading
                }
              >
                {trashBulkActionLoading ? 'Processing...' : 'Restore Selected'}
              </button>
              <button
                type="button"
                className="btn btn-delete"
                onClick={onBulkDeleteForever}
                disabled={
                  !selectedTrashCount ||
                  trashLoading ||
                  Boolean(trashActionLoadingId) ||
                  trashBulkActionLoading
                }
              >
                {trashBulkActionLoading ? 'Processing...' : 'Delete Forever Selected'}
              </button>
            </div>
          </div>
        )}

        {trashPurgedCount > 0 && (
          <p className="muted tiny">Auto-purged {trashPurgedCount} expired item(s) in this refresh.</p>
        )}
        {trashLoadError && <p className="muted tiny">Load failed: {trashLoadError}</p>}
        {trashLoading && !trashLoadError && <p className="muted tiny">Loading Trash...</p>}

        {!trashLoading && !trashLoadError && !trashItems.length && (
          <p className="muted">{trashQuery.trim() ? 'No Trash items match your search.' : 'Trash is empty.'}</p>
        )}

        {!!trashItems.length && (
          <ul className="notion-trash-list" aria-label="Trashed documents">
            {trashItems.map((item) => {
              const docId = toPositiveId(item?.id);
              const checked = selectedIdSet.has(docId);
              const busy =
                trashBulkActionLoading ||
                trashActionLoadingId === `restore-${docId}` ||
                trashActionLoadingId === `delete-${docId}`;
              const tags = Array.isArray(item?.tags) ? item.tags.filter(Boolean).slice(0, 5) : [];
              return (
                <li key={`trash-item-${docId}`}>
                  <div className="notion-trash-item-head">
                    <div className="notion-trash-item-title">
                      <label className="notion-trash-item-select">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onToggleTrashDocumentSelection(docId)}
                          disabled={trashLoading || Boolean(trashActionLoadingId) || trashBulkActionLoading}
                          aria-label={`Select ${item?.title || `Note ${docId}`}`}
                        />
                      </label>
                      <strong>{item?.title || `Note ${docId}`}</strong>
                    </div>
                    <span>{String(getDocExt(item) || 'file').toUpperCase()}</span>
                  </div>
                  <p className="muted tiny">
                    Deleted: {formatDateTimeLabel(item?.deletedAt || item?.deleted_at)} · Uploaded:{' '}
                    {formatDateTimeLabel(item?.uploadedAt || item?.uploaded_at)}
                  </p>
                  <p className="muted tiny">
                    Category: {normalizeCategory(item?.category)}
                    {tags.length ? ` · Tags: ${tags.join(', ')}` : ''}
                  </p>
                  <div className="notion-trash-item-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => onRestoreFromTrash(item)}
                      disabled={busy || Boolean(trashActionLoadingId)}
                    >
                      {busy && trashActionLoadingId.startsWith('restore-') ? 'Restoring...' : 'Restore'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-delete"
                      onClick={() => onDeleteForeverFromTrash(item)}
                      disabled={busy || Boolean(trashActionLoadingId)}
                    >
                      {busy && trashActionLoadingId.startsWith('delete-') ? 'Deleting...' : 'Delete Forever'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {!!trashItems.length && trashPageCount > 1 && (
          <div className="notion-trash-pagination">
            <span className="muted tiny">
              Page {trashPage} / {trashPageCount}
            </span>
            <div className="notion-trash-pagination-actions">
              <button
                type="button"
                className="btn"
                onClick={onPreviousPage}
                disabled={trashLoading || trashPage <= 1 || Boolean(trashActionLoadingId) || trashBulkActionLoading}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn"
                onClick={onNextPage}
                disabled={
                  trashLoading ||
                  trashPage >= trashPageCount ||
                  Boolean(trashActionLoadingId) ||
                  trashBulkActionLoading
                }
              >
                Next
              </button>
            </div>
          </div>
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
