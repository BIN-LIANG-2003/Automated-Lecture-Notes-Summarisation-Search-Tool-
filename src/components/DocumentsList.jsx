import { fmtDate } from '../lib/dates.js';

export default function DocumentsList({ documents, isLoggedIn, meta, onView, onDelete, onEdit }) {
  return (
    <>
      <span id="list-meta" className="muted" aria-live="polite">
        {meta}
      </span>
      {documents.length ? (
        <div id="documents-container" className="cards" role="list">
          {documents.map((doc) => (
            <article key={doc.id} className="document-card" role="listitem">
              <h3>{doc.title}</h3>
              <div className="document-meta">Uploaded: {fmtDate(doc.uploadedAt)}</div>
              <div className="document-meta">
                Tags: {doc.tags?.length ? doc.tags.join(', ') : 'None'}
              </div>
              <button
                className="edit-tags"
                onClick={() => isLoggedIn && onEdit?.(doc)}
                title={isLoggedIn ? undefined : 'Please sign in'}
                type="button"
                disabled={!isLoggedIn}
              >
                Edit tags
              </button>
              <div className="document-actions">
                <button
                  className="btn btn-view"
                  onClick={() => isLoggedIn && onView?.(doc)}
                  title={isLoggedIn ? undefined : 'Please sign in'}
                  disabled={!isLoggedIn}
                  type="button"
                >
                  View
                </button>
                <button
                  className="btn btn-delete"
                  onClick={() => isLoggedIn && onDelete?.(doc)}
                  title={isLoggedIn ? undefined : 'Please sign in'}
                  disabled={!isLoggedIn}
                  type="button"
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div id="empty-state" className="empty">
          No matching documents. Try another query or clear filters.
        </div>
      )}
    </>
  );
}
