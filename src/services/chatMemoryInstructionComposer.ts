import * as vscode from 'vscode';
import type { ChatMemoryInstructionBuildInput } from '../utils/chatMemoryInstructionBuilder.js';
import { buildChatMemoryInstruction } from '../utils/chatMemoryInstructionBuilder.js';

export interface ChatMemoryInstructionComposeInput extends Omit<ChatMemoryInstructionBuildInput, 'locale'> { }

export class ChatMemoryInstructionComposer {
	private getLocale(): string {
		return vscode.env.language || 'en';
	}

	compose(input: ChatMemoryInstructionComposeInput): string {
		return buildChatMemoryInstruction({
			...input,
			locale: this.getLocale(),
		});
	}
}