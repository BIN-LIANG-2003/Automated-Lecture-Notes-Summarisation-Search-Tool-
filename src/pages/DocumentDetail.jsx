import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

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
    tags,
  };
};

export default function DocumentDetail() {
  const { docId } = useParams();
  const navigate = useNavigate();
  const [document, setDocument] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [extractedText, setExtractedText] = useState('');
  const [analysisResult, setAnalysisResult] = useState(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  useEffect(() => {
    const fetchDoc = async () => {
      try {
        const res = await fetch(`/api/documents/${docId}`);
        if (!res.ok) throw new Error('Document not found');
        const data = normalizeDocument(await res.json());
        setDocument(data);
        setExtractedText(data?.content || '');
        setAnalysisResult(null);
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

  const handleExtractText = async () => {
    setIsExtracting(true);
    try {
      const response = await fetch(`/api/extract-text/${docId}`, {
        method: 'POST',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = [data?.error, data?.details?.huggingface, data?.details?.local].filter(Boolean).join(' | ');
        throw new Error(detail || '服务异常');
      }

      const text = typeof data.text === 'string' ? data.text : '';
      setExtractedText(text);
      setAnalysisResult(null);
    } catch (err) {
      alert(`文字提取失败：${err.message || '未知错误'}`);
    } finally {
      setIsExtracting(false);
    }
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
        throw new Error(data.error || '服务异常');
      }
      setAnalysisResult(data);
    } catch (err) {
      alert(`分析失败：${err.message || '未知错误'}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
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
            <div className="document-meta">Tags: {document.tags?.length ? document.tags.join(', ') : 'None'}</div>
          </div>
          
          <a href={fileUrl} target="_blank" rel="noreferrer" className="btn btn-primary" style={{flexShrink: 0}}>
            Download 
          </a>
        </header>

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
              <div className="notion-ai-actions-simple">
                {isImage && (
                  <button
                    type="button"
                    className="btn notion-ai-action-chip"
                    onClick={handleExtractText}
                    disabled={isExtracting}
                  >
                    {isExtracting ? '图像识别中...' : '图像识别'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-primary notion-ai-action-chip"
                  onClick={handleAnalyzeText}
                  disabled={isAnalyzing || !extractedText.trim()}
                >
                  {isAnalyzing ? '文本摘要中...' : '文本摘要'}
                </button>
              </div>

              <article className="notion-ai-output">
                <h3>文本内容</h3>
                <textarea
                  value={extractedText}
                  onChange={(event) => setExtractedText(event.target.value)}
                  rows={8}
                  style={{ width: '100%' }}
                  placeholder="OCR 识别结果会显示在这里，也可以手动修改。"
                />
              </article>

              {analysisResult && (
                <article className="notion-ai-output">
                  <h3>摘要结果</h3>
                  <p>{analysisResult.summary || '暂无摘要结果。'}</p>
                  <h4>关键词</h4>
                  <ul>
                    {(Array.isArray(analysisResult.keywords) ? analysisResult.keywords : []).map((keyword, index) => (
                      <li key={`${keyword}-${index}`}>{keyword}</li>
                    ))}
                  </ul>
                </article>
              )}
            </article>
          </section>
        </section>
      </article>
    </main>
  );
}
