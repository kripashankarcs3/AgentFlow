import * as vscode from 'vscode';
import { AgentFlowView } from './agentFlowView';
import { SessionStore } from './sessionStore';
import { initProviders, disposeProviders } from './providers/providerFactory';

export function activate(context: vscode.ExtensionContext): void {
  initProviders(context);

  const sessionStore = new SessionStore(context.globalState);
  const viewProvider = new AgentFlowView(context.extensionUri, sessionStore);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentFlowView.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentflow.newChat', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.agentflow');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentflow.clearChats', async () => {
      await sessionStore.clear();
      vscode.window.showInformationMessage('AgentFlow chats cleared.');
    }),
  );
}

export async function deactivate(): Promise<void> {
  await disposeProviders();
}
