/** Точка входа страницы доски быстрых заметок. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { QuickNotesBoardApp } from './QuickNotesBoardApp';

const container = document.getElementById('root');
if (container) {
	createRoot(container).render(<QuickNotesBoardApp />);
}
