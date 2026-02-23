/**
 * Sidebar webview entry point
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { SidebarApp } from './SidebarApp';

const container = document.getElementById('root')!;
const root = createRoot(container);
root.render(<SidebarApp />);
