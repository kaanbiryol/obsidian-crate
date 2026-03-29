export function isStandalonePriorityMarkerAt(content: string, index: number): boolean {
	if (content[index] !== '!') {
		return false;
	}

	const isStart = index === 0;
	const isEnd = index === content.length - 1;
	const before = isStart ? '' : content[index - 1] ?? '';
	const after = isEnd ? '' : content[index + 1] ?? '';

	return (isStart || /\s/.test(before)) && (isEnd || /\s/.test(after));
}

export function findStandalonePriorityMarkerIndexes(content: string): number[] {
	const indexes: number[] = [];

	for (let index = content.indexOf('!'); index !== -1; index = content.indexOf('!', index + 1)) {
		if (isStandalonePriorityMarkerAt(content, index)) {
			indexes.push(index);
		}
	}

	return indexes;
}

export function removeStandalonePriorityMarkers(content: string): string {
	const priorityIndexes = new Set(findStandalonePriorityMarkerIndexes(content));
	if (priorityIndexes.size === 0) {
		return content;
	}

	let result = '';
	for (let index = 0; index < content.length; index++) {
		if (!priorityIndexes.has(index)) {
			result += content[index];
		}
	}

	return result;
}
