import { createHash } from 'crypto';
import type { CodeMapBranchResolution, CodeMapInstructionKind, CodeMapSettings, StoredCodeMapInstruction } from '../types/codemap.js';

const CODEMAP_GENERATION_SCHEMA_VERSION = '2026-03-17.1';

type RefreshRelevantSettings = Pick<CodeMapSettings, 'blockDescriptionMode' | 'blockMaxChars'>;

export function buildCodeMapGenerationFingerprint(settings: RefreshRelevantSettings): string {
	return createHash('sha1')
		.update(JSON.stringify({
			schema: CODEMAP_GENERATION_SCHEMA_VERSION,
			blockDescriptionMode: settings.blockDescriptionMode,
			blockMaxChars: Math.max(0, Math.floor(settings.blockMaxChars || 0)),
		}))
		.digest('hex');
}

export function resolveInstructionSnapshotToken(
	resolution: Pick<CodeMapBranchResolution, 'resolvedTreeSha' | 'currentTreeSha' | 'resolvedHeadSha' | 'currentHeadSha'>,
	instructionKind: CodeMapInstructionKind,
): string {
	if (instructionKind === 'base') {
		return String(resolution.resolvedTreeSha || resolution.resolvedHeadSha || '').trim();
	}
	return String(resolution.currentTreeSha || resolution.currentHeadSha || '').trim();
}

export function getStoredInstructionSnapshotToken(
	instruction: Pick<StoredCodeMapInstruction, 'sourceCommitSha' | 'metadata'>,
): string {
	const metadataToken = typeof instruction.metadata?.sourceSnapshotToken === 'string'
		? instruction.metadata.sourceSnapshotToken.trim()
		: '';
	return metadataToken || String(instruction.sourceCommitSha || '').trim();
}

export function isInstructionFreshForResolution(input: {
	instruction: Pick<StoredCodeMapInstruction, 'sourceCommitSha' | 'metadata'> | null;
	resolution: Pick<CodeMapBranchResolution, 'resolvedTreeSha' | 'currentTreeSha' | 'resolvedHeadSha' | 'currentHeadSha'>;
	instructionKind: CodeMapInstructionKind;
	settings: RefreshRelevantSettings;
}): boolean {
	if (!input.instruction) {
		return false;
	}

	const storedMetadataToken = typeof input.instruction.metadata?.sourceSnapshotToken === 'string'
		? input.instruction.metadata.sourceSnapshotToken.trim()
		: '';
	const expectedSnapshotToken = resolveInstructionSnapshotToken(input.resolution, input.instructionKind);
	const expectedHeadSha = input.instructionKind === 'base'
		? String(input.resolution.resolvedHeadSha || '').trim()
		: String(input.resolution.currentHeadSha || '').trim();
	const actualSnapshotToken = storedMetadataToken
		? getStoredInstructionSnapshotToken(input.instruction)
		: String(input.instruction.sourceCommitSha || '').trim();
	const expectedToken = storedMetadataToken ? expectedSnapshotToken : expectedHeadSha;
	if (expectedToken && actualSnapshotToken !== expectedToken) {
		return false;
	}

	const storedFingerprint = typeof input.instruction.metadata?.generationFingerprint === 'string'
		? input.instruction.metadata.generationFingerprint.trim()
		: '';
	if (!storedFingerprint) {
		return true;
	}

	return storedFingerprint === buildCodeMapGenerationFingerprint(input.settings);
}
