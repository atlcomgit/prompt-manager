import React from 'react';
import { createRoot } from 'react-dom/client';
import { TrackerApp } from './TrackerApp';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<TrackerApp />);
}
