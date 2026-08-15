import React from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import POS from './pages/POS';

export default function App() {
  return (
    <HashRouter>
      <Routes>
        {/* Main POS Route */}
        <Route path="/pos" element={<POS />} />
        <Route path="/" element={<Navigate to="/pos" replace />} />
        <Route path="*" element={<Navigate to="/pos" replace />} />
      </Routes>
    </HashRouter>
  );
}
