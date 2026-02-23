/**
 * Editor webview entry point
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { EditorApp } from './EditorApp';

const container = document.getElementById('root')!;
const root = createRoot(container);
root.render(<EditorApp />);
