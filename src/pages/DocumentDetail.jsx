import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

export default function DocumentDetail() {
  const { docId } = useParams();
  const navigate = useNavigate();
  const [document, setDocument] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchDoc = async () => {
      try {
        const res = await fetch(`/api/documents/${docId}`);
        if (!res.ok) throw new Error('Document not found');
        const data = await res.json();
        setDocument(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchDoc();
  }, [docId]);

  if (loading) return <div className="container document-detail"><p>Loading...</p></div>;
  if (error || !document) return <div className="container document-detail"><p>Error: {error}</p></div>;

  const fileUrl = `/uploads/${document.filename}`;
  const isImage = ['jpg', 'jpeg', 'png', 'webp'].includes(document.fileType);
  
  const headerStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '20px',
    marginBottom: '16px'
  };

  return (
    <main className="container document-detail" role="main">
      {/* 关键修改在这里：
         使用 navigate('/', { state: ... }) 
         告诉主页：我回来了，请把文件列表打开 (showFiles: true)
      */}
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
            <div className="document-meta">Tags: {document.tags?.length ? document.tags.join(', ') : 'None'}</div>
          </div>
          
          <a href={fileUrl} target="_blank" rel="noreferrer" className="btn btn-primary" style={{flexShrink: 0}}>
            Download 
          </a>
        </header>

        <section className="document-body">
          {isImage ? (
            <img src={fileUrl} alt="Preview" style={{maxWidth: '100%', borderRadius: '8px'}} />
          ) : (
            <>
              <h3 style={{marginTop:0}}>Document Content:</h3>
              <pre style={{whiteSpace: 'pre-wrap', color: '#e9ecf1', fontFamily: 'inherit'}}>
                {document.content || "No text content extracted."}
              </pre>
            </>
          )}
        </section>
      </article>
    </main>
  );
}
