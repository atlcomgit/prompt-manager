export function getChangedLineIndexes(previousContent: string, nextContent: string): number[] {
	if (previousContent === nextContent) {
		return [];
	}

	const previousLines = previousContent.split(/\r?\n/);
	const nextLines = nextContent.split(/\r?\n/);

	if (nextLines.length === 0) {
		return [];
	}

	if (previousContent.length === 0) {
		return nextLines.map((_, index) => index);
	}

	const previousCount = previousLines.length;
	const nextCount = nextLines.length;
	const lcsLengths = Array.from({ length: previousCount + 1 }, () => Array<number>(nextCount + 1).fill(0));

	for (let previousIndex = previousCount - 1; previousIndex >= 0; previousIndex -= 1) {
		for (let nextIndex = nextCount - 1; nextIndex >= 0; nextIndex -= 1) {
			lcsLengths[previousIndex][nextIndex] = previousLines[previousIndex] === nextLines[nextIndex]
				? lcsLengths[previousIndex + 1][nextIndex + 1] + 1
				: Math.max(lcsLengths[previousIndex + 1][nextIndex], lcsLengths[previousIndex][nextIndex + 1]);
		}
	}

	const changedLineIndexes = new Set<number>();
	let previousIndex = 0;
	let nextIndex = 0;
	let hasPendingDeletion = false;

	while (previousIndex < previousCount && nextIndex < nextCount) {
		if (previousLines[previousIndex] === nextLines[nextIndex]) {
			if (hasPendingDeletion) {
				changedLineIndexes.add(nextIndex);
				hasPendingDeletion = false;
			}
			previousIndex += 1;
			nextIndex += 1;
			continue;
		}

		if (lcsLengths[previousIndex + 1][nextIndex] >= lcsLengths[previousIndex][nextIndex + 1]) {
			hasPendingDeletion = true;
			previousIndex += 1;
			continue;
		}

		changedLineIndexes.add(nextIndex);
		hasPendingDeletion = false;
		nextIndex += 1;
	}

	while (nextIndex < nextCount) {
		changedLineIndexes.add(nextIndex);
		nextIndex += 1;
	}

	if (hasPendingDeletion && nextCount > 0) {
		changedLineIndexes.add(Math.max(0, nextCount - 1));
	}

	return Array.from(changedLineIndexes).sort((left, right) => left - right);
}