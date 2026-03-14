import type { CodeMapMaterializationTarget } from '../types/codemap.js';

export class CodeMapMaterializerService {
	compose(
		targets: CodeMapMaterializationTarget[],
		generatedAt = new Date().toISOString(),
		locale = 'en',
	): string {
		return buildCodeMapChatInstructions({
			generatedAt,
			locale,
			targets,
		});
	}
}

export function buildCodeMapChatInstructions(input: {
	generatedAt: string;
	locale: string;
	targets: CodeMapMaterializationTarget[];
}): string {
	const isRussianLocale = input.locale.toLowerCase().startsWith('ru');
	const text = isRussianLocale
		? {
			heading: '# Code Map инструкции для текущего чата',
			purposeTitle: '## Назначение',
			purposeText: 'Этот файл содержит актуальные или последние сохраненные codemap-инструкции по выбранным проектам и веткам. Используй его как фоновую карту кода при работе в чате.',
			generatedAt: 'Сформировано',
			missingTitle: '### Инструкция пока не готова',
			missingText: 'Для этой пары проект+ветка сохраненная инструкция еще не найдена. Обновление поставлено в очередь и будет выполнено в фоне.',
			currentSnapshotTitle: '### Снимок текущей ветки',
			uncommittedTitle: '### Незакомиченные изменения',
			queueLine: '### Состояние очереди обновления',
			queued: 'обновление поставлено в очередь',
			notQueued: 'актуальная запись уже есть',
			noTargets: 'Выбранные проекты для codemap не определены.',
		}
		: {
			heading: '# Code Map Instructions for the Current Chat',
			purposeTitle: '## Purpose',
			purposeText: 'This file contains current or last persisted codemap instructions for the selected projects and branches. Use it as background code-map context while working in chat.',
			generatedAt: 'Generated at',
			missingTitle: '### Instruction not ready yet',
			missingText: 'No persisted instruction was found for this project+branch pair yet. A refresh job has been queued and will run in the background.',
			currentSnapshotTitle: '### Current branch snapshot',
			uncommittedTitle: '### Uncommitted changes',
			queueLine: '### Refresh queue state',
			queued: 'refresh queued',
			notQueued: 'latest record already available',
			noTargets: 'No codemap projects were selected.',
		};

	if (input.targets.length === 0) {
		return [
			'---',
			"applyTo: '**'",
			'---',
			'',
			text.heading,
			'',
			text.purposeTitle,
			text.purposeText,
			'',
			`- ${text.generatedAt}: ${input.generatedAt}`,
			'',
			text.noTargets,
		].join('\n');
	}

	const sections = input.targets.flatMap((target) => {
		const baseHeader = [`## ${target.resolution.repository}`, '', `- Current branch: ${target.resolution.currentBranch}`, `- Resolved branch: ${target.resolution.resolvedBranchName}`, `- Base branch: ${target.resolution.baseBranchName}`, `- Queue: ${target.queuedBaseRefresh ? text.queued : text.notQueued}`];
		const content: string[] = [...baseHeader, ''];

		if (target.baseInstruction) {
			content.push(target.baseInstruction.content);
		} else {
			content.push(text.missingTitle, text.missingText);
		}

		if (target.currentInstruction && target.currentInstruction.branchName !== target.resolution.resolvedBranchName) {
			content.push('', text.currentSnapshotTitle, '', target.currentInstruction.content);
		} else if (target.queuedCurrentRefresh && target.resolution.currentBranch !== target.resolution.resolvedBranchName) {
			content.push('', text.queueLine, `- ${target.resolution.currentBranch}: ${text.queued}`);
		}

		if (target.uncommittedSummary?.trim()) {
			content.push('', text.uncommittedTitle, '', target.uncommittedSummary.trim());
		}

		return content;
	});

	return [
		'---',
		"applyTo: '**'",
		'---',
		'',
		text.heading,
		'',
		text.purposeTitle,
		text.purposeText,
		'',
		`- ${text.generatedAt}: ${input.generatedAt}`,
		'',
		...sections,
	].join('\n');
}