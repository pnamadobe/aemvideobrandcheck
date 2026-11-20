import React from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import ExtensionRegistration from './ExtensionRegistration';
import VideoBrandCheckPanel from './VideoBrandCheckPanel';

function ErrorFallback({ error }) {
  return (
    <div style={{ padding: 16 }}>
      <h3>Video Brand Check Extension Error</h3>
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{error?.message}</pre>
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <ErrorBoundary FallbackComponent={ErrorFallback}>
        <Routes>
          <Route index element={<ExtensionRegistration />} />
          <Route path="index.html" element={<ExtensionRegistration />} />
          <Route path="brand-check-panel" element={<VideoBrandCheckPanel mode="panel" />} />
          <Route path="brand-check-modal" element={<VideoBrandCheckPanel mode="modal" />} />
        </Routes>
      </ErrorBoundary>
    </Router>
  );
}
