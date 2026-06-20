import * as vscode from 'vscode';
import { GeminiBrowserProvider } from './geminiBrowserProvider';
import { AgentProvider } from './provider';
import { ProviderId } from '../types';

let geminiProvider: GeminiBrowserProvider | null = null;

export function initProviders(context: vscode.ExtensionContext): void {
  geminiProvider = new GeminiBrowserProvider(context.globalStorageUri.fsPath);
}

export function getDefaultProviderId(): ProviderId {
  return 'gemini-browser';
}

export function createProvider(providerId: ProviderId): AgentProvider {
  if (providerId !== 'gemini-browser') {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  if (!geminiProvider) {
    throw new Error('Provider not initialized. Call initProviders first.');
  }
  return geminiProvider;
}

export async function disposeProviders(): Promise<void> {
  if (geminiProvider) {
    await geminiProvider.dispose();
    geminiProvider = null;
  }
}
