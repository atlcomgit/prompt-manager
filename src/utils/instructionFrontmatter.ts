/** Legacy instruction frontmatter that used to be auto-injected into saved Markdown files. */
const LEGACY_APPLY_TO_FRONTMATTER = /^---\s*\r?\napplyTo\s*:\s*(?:"\*\*"|'\*\*'|\*\*)\s*\r?\n---\s*(?:\r?\n)?/;

/** Removes only the legacy applyTo frontmatter block, preserving any other user-authored YAML. */
export function stripLegacyInstructionFrontmatter(text: string): string {
	const raw = typeof text === 'string' ? text : '';
	return raw.replace(LEGACY_APPLY_TO_FRONTMATTER, '');
}

/** Normalizes instruction Markdown for storage without re-adding legacy frontmatter. */
export function normalizeInstructionMarkdownContent(text: string): string {
	const normalized = stripLegacyInstructionFrontmatter(text).trim();
	return normalized ? `${normalized}\n` : '';
}