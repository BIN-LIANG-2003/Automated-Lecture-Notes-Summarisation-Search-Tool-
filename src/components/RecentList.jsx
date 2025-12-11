import { fmtDate } from '../lib/dates.js';

export default function RecentList({ documents }) {
  if (!documents.length) {
    return (
      <div id="recent-empty" className="empty">
        No recent activity yet. Open a file or edit tags to see it here.
      </div>
    );
  }

  return (
    <div id="recent-container" className="cards recent-cards" role="list">
      {documents.map((doc) => (
        <article key={doc.id} className="document-card" role="listitem">
          <h3>{doc.title}</h3>
          <div className="document-meta">Last used: {fmtDate(doc.lastAccessAt)}</div>
          <div className="document-meta">
            Tags: {doc.tags?.length ? doc.tags.join(', ') : 'None'}
          </div>
        </article>
      ))}
    </div>
  );
}
