import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import HomePage from './pages/Home.jsx';
import AuthPage from './pages/Auth.jsx';
import DocumentDetail from './pages/DocumentDetail.jsx';

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<AuthPage />} />
        <Route path="/document/:docId" element={<DocumentDetail />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
