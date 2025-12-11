import { useEffect, useMemo, useRef, useState } from 'react';
// 1. 引入 useLocation
import { Link, useNavigate, useLocation } from 'react-router-dom';
import AuthMenu from '../components/AuthMenu.jsx';
import DocumentsList from '../components/DocumentsList.jsx';
import OtherDropdown from '../components/OtherDropdown.jsx';
import RecentList from '../components/RecentList.jsx';
import UsageChart from '../components/UsageChart.jsx';
import { todayKey } from '../lib/dates.js';
import { loadUsageMap, persistUsageMap } from '../lib/usage.js';

export default function HomePage() {
  const [documents, setDocuments] = useState([]);
  const navigate = useNavigate();
  // 2. 获取当前路由状态
  const location = useLocation();

  const [filters, setFilters] = useState({ query: '', start: '', end: '', tag: '' });
  const [searchDraft, setSearchDraft] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(() => Boolean(localStorage.getItem('username')));
  
  // 3. 关键修改：初始化 showFiles 时，检查 location.state 是否要求显示
  const [showFiles, setShowFiles] = useState(() => {
    return location.state?.showFiles || false;
  });

  const [fileHint, setFileHint] = useState('');
  const fileInputRef = useRef(null);
  const [usageMap, setUsageMap] = useState(() => loadUsageMap());
  const sessionStartRef = useRef(null);

  const username = localStorage.getItem('username');

  const fetchDocuments = async () => {
    if (!username) {
      setDocuments([]);
      return;
    }
    try {
      const res = await fetch(`/api/documents?username=${username}`);
      if (res.ok) {
        const data = await res.json();
        setDocuments(data);
      }
    } catch (err) {
      console.error("Failed to fetch documents", err);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, [username]);

  // 如果通过 Back 按钮回来带了状态，也更新一下（防止只在刷新时生效）
  useEffect(() => {
    if (location.state?.showFiles) {
      setShowFiles(true);
    }
  }, [location.state]);

  useEffect(() => {
    const handleStorage = () => setIsLoggedIn(Boolean(localStorage.getItem('username')));
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    const startSession = () => {
      sessionStartRef.current = Date.now();
    };
    const stopSession = () => {
      if (!sessionStartRef.current) return;
      const deltaSec = Math.max(0, Math.round((Date.now() - sessionStartRef.current) / 1000));
      sessionStartRef.current = null;
      if (!deltaSec) return;
      setUsageMap((prev) => {
        const next = { ...prev };
        const key = todayKey();
        next[key] = (next[key] || 0) + deltaSec;
        persistUsageMap(next);
        return next;
      });
    };
    if (document.visibilityState === 'visible') startSession();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') startSession();
      else stopSession();
    };
    const handleBeforeUnload = () => stopSession();
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      stopSession();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  const filteredDocuments = useMemo(() => {
    const { query, start, end, tag } = filters;
    const lower = query.trim().toLowerCase();
    const startDate = start ? new Date(`${start}T00:00:00`) : null;
    const endDate = end ? new Date(`${end}T23:59:59`) : null;

    return documents.filter((doc) => {
      const matchesQuery = lower
        ? doc.title?.toLowerCase().includes(lower) ||
          (doc.tags || []).some((t) => t.toLowerCase().includes(lower))
        : true;
      const uploaded = new Date(doc.uploadedAt);
      const matchesStart = startDate ? uploaded >= startDate : true;
      const matchesEnd = endDate ? uploaded <= endDate : true;
      const matchesTag = tag ? (doc.tags || []).includes(tag) : true;
      return matchesQuery && matchesStart && matchesEnd && matchesTag;
    });
  }, [documents, filters]);

  const tags = useMemo(() => {
    const bag = new Set();
    documents.forEach((doc) => (doc.tags || []).forEach((tag) => bag.add(tag)));
    return Array.from(bag);
  }, [documents]);

  const formatDisplayDate = (value) => {
    if (!value) return 'YYYY/MM/DD';
    const [year, month, day] = value.split('-');
    return [year, month, day].filter(Boolean).join('/');
  };

  const recentDocuments = useMemo(
    () =>
      documents
        .filter((doc) => doc.lastAccessAt)
        .sort((a, b) => new Date(b.lastAccessAt) - new Date(a.lastAccessAt))
        .slice(0, 6),
    [documents]
  );

  const handleSignOut = () => {
    localStorage.removeItem('username');
    localStorage.removeItem('loginAt');
    setIsLoggedIn(false);
    setDocuments([]);
  };

  const describeFiles = (fileList) =>
    fileList.length
      ? `Selected: ${fileList
          .map((file) => {
            const mb = (file.size / (1024 * 1024)).toFixed(2);
            return `${file.name} (${mb} MB)`;
          })
          .join(', ')}`
      : '';

  const handleFileChange = (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) {
      setFileHint('');
      return;
    }
    setFileHint(describeFiles(files));
  };

  const handleUpload = async (event) => {
    event.preventDefault();
    if (!isLoggedIn) {
      alert('Please sign in before uploading.');
      return;
    }
    const files = Array.from(fileInputRef.current?.files || []);
    if (!files.length) {
      alert('Please choose at least one file first.');
      return;
    }

    const username = localStorage.getItem('username');
    let successCount = 0;
    
    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('username', username);

      try {
        const response = await fetch('/api/documents/upload', {  
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response.json();
          alert(`Upload failed for ${file.name}: ${errorData.error}`);
        } else {
          successCount++;
        }
      } catch (error) {
        console.error('Upload error:', error);
        alert(`Network error uploading ${file.name}. Is the backend running?`);
      }
    }

    if (successCount > 0) {
      event.target.reset();
      if (fileInputRef.current) fileInputRef.current.value = '';
      setFileHint('');
      alert(`Upload complete! (${successCount}/${files.length} success)`);
      fetchDocuments();
    }
  };

  const handleView = (doc) => {
    navigate(`/document/${doc.id}`);
  };

  const handleDelete = (doc) => {
    if (!window.confirm(`Delete “${doc.title}”?`)) return;
    setDocuments((prev) => prev.filter((item) => item.id !== doc.id));
  };

  const handleEdit = (doc) => {
    const input = window.prompt('Enter tags separated by commas:', (doc.tags || []).join(','));
    if (input === null) return;
    const tags = input
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    setDocuments((prev) =>
      prev.map((item) =>
        item.id === doc.id
          ? { ...item, tags }
          : item
      )
    );
  };

  const applySearch = () => {
    setFilters((prev) => ({ ...prev, query: searchDraft.trim() }));
  };

  const clearFilters = () => {
    setFilters({ query: '', start: '', end: '', tag: '' });
    setSearchDraft('');
  };

  return (
    <>
      {!isLoggedIn && (
        <div id="login-warning" className="login-warning" role="alert">
          <div className="container login-warning-inner">
            <div className="login-warning-text">
              <strong>You&apos;re not signed in.</strong> Some actions (upload / view / delete / edit
              tags) require sign-in.
            </div>
          </div>
        </div>
      )}

      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header className="navbar" role="banner">
        <div className="container nav-inner">
          <div className="brand">
            <img src="/logo.png" alt="StudyHub Logo" width="40" height="40" />
            <strong>StudyHub</strong>
          </div>
          <nav aria-label="Primary">
            <ul className="nav-links">
              <li className="nav-other">
                <OtherDropdown />
              </li>
              <li>
                <Link to="/">Home</Link>
              </li>
              <li>
                <AuthMenu isLoggedIn={isLoggedIn} onSignOut={handleSignOut} />
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main id="main" className="container" role="main">
        <section className="hero" aria-labelledby="hero-title">
          <div>
            <h1 id="hero-title">Organise &amp; search your lecture notes</h1>
            <p className="muted">Browse without signing in; sign in to upload and manage files.</p>
          </div>
            <img
            src="/logo.png"
            alt="Notes illustration"
            className="hero-image"
            width="240"
            height="160"
          />
        </section>

        <section className="quick-actions">
          <button
            id="toggle-files-btn"
            className="btn btn-primary"
            type="button"
            aria-controls="files-section"
            aria-expanded={showFiles ? 'true' : 'false'}
            onClick={() => setShowFiles((prev) => !prev)}
          >
            {showFiles ? 'Hide my files' : 'My files'}
          </button>
        </section>

        {!showFiles && (
          <>
            <UsageChart usageMap={usageMap} />

            <section className="recent-card" aria-labelledby="recent-title">
              <div className="list-head">
                <h2 id="recent-title" className="section-title">
                  Recently used files
                </h2>
                <span id="recent-meta" className="muted tiny" aria-live="polite">
                  {recentDocuments.length ? `Showing ${recentDocuments.length}` : ''}
                </span>
              </div>
              <RecentList documents={recentDocuments} />
            </section>
          </>
        )}

        {showFiles && (
          <section id="files-section" className="files-section">
            <section className="filters" aria-labelledby="filters-title">
              <h2 id="filters-title" className="sr-only">
                Filters
              </h2>

              <div className="filter-row">
                <label htmlFor="search-input" className="sr-only">
                  Search
                </label>
                <div className="input-with-icon">
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M21 21l-4.3-4.3m1.3-4.7a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <input
                    id="search-input"
                    type="search"
                    placeholder="Search title or tag (press Enter)"
                    inputMode="search"
                    value={searchDraft}
                    onChange={(event) => setSearchDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        applySearch();
                      }
                    }}
                  />
                </div>
                <button
                  id="search-btn"
                  className="btn btn-primary"
                  type="button"
                  onClick={applySearch}
                >
                  Search
                </button>

                <div className="date-group">
                  <label htmlFor="start-date">Start</label>
                  <div className="date-input-wrapper" data-filled={filters.start ? 'true' : 'false'}>
                    <input
                      id="start-date"
                      type="date"
                      lang="en-US"
                      value={filters.start}
                      onChange={(event) =>
                        setFilters((prev) => ({ ...prev, start: event.target.value }))
                      }
                    />
                    <span className="date-faux">{formatDisplayDate(filters.start)}</span>
                  </div>
                  <label htmlFor="end-date">End</label>
                  <div className="date-input-wrapper" data-filled={filters.end ? 'true' : 'false'}>
                    <input
                      id="end-date"
                      type="date"
                      lang="en-US"
                      value={filters.end}
                      onChange={(event) =>
                        setFilters((prev) => ({ ...prev, end: event.target.value }))
                      }
                    />
                    <span className="date-faux">{formatDisplayDate(filters.end)}</span>
                  </div>
                </div>

                <button id="clear-filters" className="btn" type="button" onClick={clearFilters}>
                  Clear
                </button>
              </div>

              <div className="tags-row">
                <span className="muted">Tags:</span>
                <div id="tags-container" className="tags" role="list" aria-label="Tag filters">
                  {tags.length ? (
                    tags.map((tag) => (
                      <button
                        type="button"
                        key={tag}
                        className={`tag ${filters.tag === tag ? 'selected' : ''}`}
                        role="listitem"
                        onClick={() =>
                          setFilters((prev) => ({
                            ...prev,
                            tag: prev.tag === tag ? '' : tag
                          }))
                        }
                      >
                        {tag}
                      </button>
                    ))
                  ) : (
                    <span className="muted">No tags yet</span>
                  )}
                </div>
              </div>
            </section>

            <section className="uploader" aria-labelledby="uploader-title">
              <h2 id="uploader-title" className="section-title">
                Upload
              </h2>
              <form id="upload-form" onSubmit={handleUpload} noValidate>
                <input
                  id="file-input"
                  type="file"
                  accept=".pdf,.docx,.txt,image/*"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  className="sr-only"
                />
                <div className="uploader-actions">
                  <label htmlFor="file-input" className="btn file-btn">
                    Choose file
                  </label>
                  <button id="upload-btn" className="btn btn-primary" type="submit">
                    Upload
                  </button>
                </div>
                <span id="file-hint" className="muted file-picker-text" aria-live="polite">
                  {fileHint || 'No file chosen'}
                </span>
              </form>
              <p className="muted tiny">
                PDF/DOCX/TXT/Images supported (images used for OCR). Max 20 MB per file.
              </p>
            </section>

            <section aria-labelledby="docs-title">
              <div className="list-head">
                <h2 id="docs-title" className="section-title">
                  My documents
                </h2>
              </div>
              <DocumentsList
                documents={filteredDocuments}
                isLoggedIn={isLoggedIn}
                meta={`Showing ${filteredDocuments.length} (total ${documents.length})`}
                onView={handleView}
                onDelete={handleDelete}
                onEdit={handleEdit}
              />
            </section>
          </section>
        )}
      </main>

      <footer className="footer container">
        <small className="muted">
          Demo for coursework. Backend connected.
        </small>
      </footer>
    </>
  );
}
