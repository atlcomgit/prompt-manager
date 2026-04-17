import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatLaunchOpenStepLabel } from '../src/webview/editor/components/ChatLaunchOpenStepLabel.js';

test('ChatLaunchOpenStepLabel renders bold model name when it is available', () => {
	const markup = renderToStaticMarkup(React.createElement(ChatLaunchOpenStepLabel, {
		label: 'Открываем Copilot Chat',
		modelName: ' GPT-5.4 ',
	}));

	assert.match(markup, /Открываем Copilot Chat: <strong>GPT-5\.4<\/strong>/);
});

test('ChatLaunchOpenStepLabel keeps the base label when no model is selected', () => {
	const markup = renderToStaticMarkup(React.createElement(ChatLaunchOpenStepLabel, {
		label: 'Открываем Copilot Chat',
		modelName: '   ',
	}));

	assert.equal(markup, 'Открываем Copilot Chat');
});