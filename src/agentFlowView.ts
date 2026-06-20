import * as vscode from 'vscode';
import { createProvider, getDefaultProviderId } from './providers/providerFactory';
import { SessionStore } from './sessionStore';
import { Session, ToolRequest } from './types';
import { ToolExecutor } from './tools/toolExecutor';

export class AgentFlowView implements vscode.WebviewViewProvider {
  static readonly viewType = 'agentflow.sidebar';

  private view?: vscode.WebviewView;
  private activeSession: Session;
  private readonly toolExecutor: ToolExecutor;
  private sending = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionStore: SessionStore,
  ) {
    const storedSessionId = this.sessionStore.getActiveSessionId();
    this.activeSession =
      (storedSessionId ? this.sessionStore.get(storedSessionId) : undefined) ??
      this.sessionStore.list()[0] ??
      this.sessionStore.create('gemini-browser');

    if (this.activeSession.provider !== 'gemini-browser') {
      this.activeSession.provider = 'gemini-browser';
    }
    this.toolExecutor = new ToolExecutor(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? vscode.workspace.rootPath ?? '',
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml(view.webview);

    view.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          this.sync();
          break;
        case 'new-chat':
          this.activeSession = this.sessionStore.create(getDefaultProviderId());
          await this.persist();
          this.sync();
          break;
        case 'clear-chats':
          await this.sessionStore.clear();
          this.activeSession = this.sessionStore.create(getDefaultProviderId());
          await this.sessionStore.setActiveSessionId(this.activeSession.id);
          this.sync();
          break;
        case 'select-session': {
          const session = this.sessionStore.get(String(message.sessionId));
          if (session) {
            this.activeSession = session;
            await this.sessionStore.setActiveSessionId(this.activeSession.id);
            this.sync();
          }
          break;
        }
        case 'send-message':
          await this.handleSend(String(message.content ?? ''));
          break;
      }
    });
  }

  private async handleSend(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed || this.sending) return;

    this.sending = true;
    this.updateSending(true);

    this.activeSession.messages.push({ role: 'user', content: trimmed });
    this.activeSession.title =
      this.activeSession.title === 'New chat' ? trimmed.slice(0, 40) : this.activeSession.title;
    await this.persist();
    this.sync();

    try {
      const provider = createProvider(this.activeSession.provider);
      const history = [...this.activeSession.messages];

      for (let turns = 0; turns < 5; turns += 1) {
        this.updateStatus('Gemini is thinking...');
        const assistantText = await provider.send(history);
        this.activeSession.messages.push({ role: 'assistant', content: assistantText });
        await this.persist();
        this.sync();

        const toolRequest = this.extractToolRequest(assistantText);
        if (!toolRequest) {
          break;
        }

        const result = await this.toolExecutor.run(toolRequest);
        const toolMsg = `[${toolRequest.tool}] ${result}`;
        this.activeSession.messages.push({ role: 'tool', content: toolMsg });
        history.push({ role: 'tool', content: toolMsg });
        await this.persist();
        this.sync();

        this.updateStatus('Sending tool result back to Gemini...');
      }

      this.updateStatus('');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.activeSession.messages.push({
        role: 'tool',
        content: `Error: ${errMsg}`,
      });
      await this.persist();
      this.sync();
    } finally {
      this.sending = false;
      this.updateSending(false);
    }
  }

  private updateSending(sending: boolean): void {
    this.view?.webview.postMessage({ type: 'sending', sending });
  }

  private updateStatus(status: string): void {
    this.view?.webview.postMessage({ type: 'status', status });
  }

  private extractToolRequest(text: string): ToolRequest | null {
    const match = text.match(/```json\s*([\s\S]*?)```/i);
    if (!match) return null;

    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed.tool === 'string') {
        return parsed as ToolRequest;
      }
    } catch {
      return null;
    }

    return null;
  }

  private async persist(): Promise<void> {
    this.activeSession.updatedAt = Date.now();
    await this.sessionStore.upsert(this.activeSession);
    await this.sessionStore.setActiveSessionId(this.activeSession.id);
  }

  private sync(): void {
    if (!this.view) return;

    this.view.webview.postMessage({
      type: 'state',
      sessions: this.sessionStore.list(),
      activeSessionId: this.activeSession.id,
      activeSession: this.activeSession,
      provider: this.activeSession.provider,
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = Date.now().toString();
    return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>AgentFlow</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --panel: rgba(255, 255, 255, .96);
      --panel-2: #ffffff;
      --panel-3: #f8fafc;
      --text: #111827;
      --muted: #64748b;
      --subtle: #94a3b8;
      --accent: #2563eb;
      --accent-soft: rgba(37, 99, 235, .10);
      --green: #059669;
      --green-soft: rgba(5, 150, 105, .10);
      --amber: #d97706;
      --amber-soft: rgba(217, 119, 6, .10);
      --border: rgba(15, 23, 42, .08);
      --border-strong: rgba(37, 99, 235, .22);
      --shadow: 0 14px 28px rgba(15, 23, 42, .08);
      --shadow-soft: 0 8px 18px rgba(15, 23, 42, .05);
      --radius-xl: 20px;
      --radius-lg: 16px;
      --radius-md: 12px;
    }
    html, body { height: 100%; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top, rgba(37, 99, 235, .08), transparent 35%),
        linear-gradient(180deg, #fbfcfe 0%, var(--bg) 100%);
      color: var(--text);
      font: 13px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    button, select, textarea { font: inherit; }
    .shell {
      height: 100%;
      display: flex;
      flex-direction: column;
      min-height: 0;
      padding: 12px;
      gap: 12px;
    }
    .topbar, .panel, .chat-card {
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, .94);
      box-shadow: var(--shadow);
      border-radius: var(--radius-xl);
      backdrop-filter: blur(10px);
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      gap: 12px;
    }
    .tabs {
      display: flex;
      gap: 16px;
      align-items: center;
      flex-wrap: wrap;
    }
    .tab {
      position: relative;
      padding: 6px 2px;
      color: var(--muted);
      background: transparent;
      border: 0;
      box-shadow: none;
      text-transform: uppercase;
      letter-spacing: .12em;
      font-size: 11px;
      font-weight: 700;
    }
    .tab.active { color: var(--text); }
    .tab.active::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      bottom: -1px;
      height: 2px;
      border-radius: 999px;
      background: var(--accent);
    }
    .top-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .icon-button {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--panel-2);
      color: var(--text);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      box-shadow: none;
    }
    .icon-button:hover {
      border-color: var(--border-strong);
      background: #f8fafc;
      transform: translateY(-1px);
    }
    .icon { font-size: 15px; line-height: 1; }
    .panel { padding: 14px; }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
    }
    .section-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .eyebrow {
      color: var(--subtle);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .14em;
      font-weight: 700;
    }
    .section-title h2 { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
    .section-title small { color: var(--muted); font-size: 12px; }
    .status-line { display: flex; align-items: center; gap: 8px; color: var(--muted); min-width: 0; }
    .status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--accent); box-shadow: 0 0 0 6px var(--accent-soft);
      flex: 0 0 auto;
    }
    .status-dot.idle { background: var(--green); box-shadow: 0 0 0 6px var(--green-soft); }
    .status-dot.busy { background: var(--amber); box-shadow: 0 0 0 6px var(--amber-soft); animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
    select, textarea {
      width: 100%;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
      background: var(--panel-3);
      color: var(--text);
      padding: 11px 12px;
    }
    select:focus, textarea:focus, button:focus-visible {
      outline: none;
      border-color: var(--border-strong);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    .action-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    button {
      cursor: pointer;
      border: 1px solid var(--border);
      color: var(--text);
      background: var(--panel-2);
      transition: transform .12s ease, border-color .12s ease, background .12s ease;
    }
    button:hover {
      transform: translateY(-1px);
      border-color: var(--border-strong);
      background: #f8fafc;
    }
    .primary {
      background: linear-gradient(180deg, #eff6ff 0%, #dbeafe 100%);
      border-color: rgba(37, 99, 235, .16);
      color: #1d4ed8;
    }
    .danger {
      background: linear-gradient(180deg, #fff7ed 0%, #ffedd5 100%);
      border-color: rgba(249, 115, 22, .18);
      color: #9a3412;
    }
    .layout {
      display: flex;
      flex-direction: column;
      min-height: 0;
      gap: 12px;
      flex: 1;
    }
    .history-grid { display: none; flex-direction: column; min-height: 0; gap: 10px; flex: 1; }
    .chat-grid { display: flex; flex-direction: column; min-height: 0; gap: 12px; flex: 1; }
    body[data-view="history"] .history-grid { display: flex; }
    body[data-view="history"] .chat-grid { display: none; }
    .list { display: grid; gap: 8px; overflow: auto; min-height: 0; padding-right: 2px; }
    .session-item {
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 12px;
      border-radius: 14px;
      background: #ffffff;
      border: 1px solid var(--border);
      text-align: left;
      box-shadow: none;
    }
    .session-item.active {
      border-color: var(--border-strong);
      background: linear-gradient(180deg, rgba(37, 99, 235, .08), rgba(37, 99, 235, .04));
    }
    .session-main { min-width: 0; flex: 1; }
    .session-title {
      font-size: 13px; font-weight: 650;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      margin-bottom: 2px;
    }
    .session-sub { color: var(--muted); font-size: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .pill {
      flex: 0 0 auto;
      padding: 5px 8px;
      border-radius: 999px;
      background: rgba(88, 166, 255, .12);
      border: 1px solid rgba(88, 166, 255, .14);
      color: #2563eb;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .chat-card {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      min-height: 0;
      overflow: hidden;
      flex: 1;
    }
    .chat-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
    }
    .chat-title { min-width: 0; }
    .chat-title h2 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
    .messages {
      min-height: 0;
      overflow: auto;
      padding: 14px 14px 10px;
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .msg { display: flex; flex-direction: column; gap: 5px; max-width: 100%; }
    .msg.user { align-items: flex-end; }
    .msg.assistant, .msg.tool { align-items: flex-start; }
    .msg-label { color: var(--subtle); font-size: 10px; letter-spacing: .14em; text-transform: uppercase; font-weight: 700; }
    .bubble {
      width: fit-content;
      max-width: 100%;
      padding: 11px 13px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: #ffffff;
      white-space: pre-wrap;
      word-break: break-word;
      box-shadow: var(--shadow-soft);
    }
    .msg.user .bubble {
      background: #f8fbff;
      border-color: rgba(37, 99, 235, .16);
      border-bottom-right-radius: 8px;
    }
    .msg.assistant .bubble {
      border-bottom-left-radius: 8px;
    }
    .msg.tool .bubble {
      background: #f0fdf9;
      border-color: rgba(20, 184, 166, .14);
      color: #0f766e;
      border-bottom-left-radius: 8px;
      font-family: monospace;
      font-size: 12px;
    }
    .msg.tool.error .bubble {
      background: #fef2f2;
      border-color: rgba(239, 68, 68, .14);
      color: #b91c1c;
    }
    .empty-state {
      height: 100%;
      display: grid;
      place-items: center;
      padding: 14px;
      text-align: center;
    }
    .empty-card {
      width: 100%;
      max-width: 320px;
      padding: 18px;
      border-radius: 18px;
      border: 1px solid rgba(88, 166, 255, .14);
      background: linear-gradient(180deg, rgba(255, 255, 255, .98), rgba(247, 249, 252, .98));
      box-shadow: var(--shadow);
    }
    .empty-icon {
      width: 40px; height: 40px;
      border-radius: 50%;
      margin: 0 auto 10px;
      border: 1px solid var(--border);
      background: radial-gradient(circle, rgba(37, 99, 235, .12), transparent 70%);
    }
    .empty-card h3 { margin: 6px 0 8px; font-size: 15px; }
    .empty-card p { margin: 0; color: var(--muted); font-size: 12px; }
    .chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 14px; }
    .chip {
      border-radius: 999px;
      padding: 8px 10px;
      background: #ffffff;
      border: 1px solid var(--border);
      color: var(--text);
      box-shadow: none;
      font-size: 12px;
    }
    .composer {
      padding: 12px 14px 14px;
      border-top: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(255, 255, 255, .94), rgba(248, 250, 252, .98));
      display: grid;
      gap: 10px;
    }
    textarea {
      min-height: 92px;
      max-height: 180px;
      resize: none;
      line-height: 1.5;
    }
    .composer-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .hint { color: var(--muted); font-size: 11px; }
    .send {
      width: auto;
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid rgba(88, 166, 255, .22);
      background: linear-gradient(180deg, #60a5fa 0%, #2563eb 100%);
      color: #fff;
      box-shadow: 0 10px 22px rgba(37, 99, 235, .18);
      flex: 0 0 auto;
    }
    .send:disabled {
      opacity: .5;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }
    .history-note { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .provider-card {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .provider-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(37, 99, 235, .08);
      border: 1px solid rgba(37, 99, 235, .14);
      color: #1d4ed8;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    #statusText { font-size: 11px; color: var(--muted); min-height: 16px; }
    @media (max-width: 420px) {
      .shell { padding: 10px; }
      .topbar { align-items: flex-start; flex-direction: column; }
      .action-row { grid-template-columns: 1fr; }
      .composer-row { flex-direction: column; align-items: stretch; }
      .send { width: 100%; }
    }
    :focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
  </style>
</head>
<body data-view="chat">
  <div class="shell">
    <header class="topbar">
      <div class="tabs">
        <button id="chatTab" class="tab active" type="button">Chat</button>
        <button id="historyTab" class="tab" type="button">History</button>
      </div>
      <div class="top-actions">
        <button id="newChatIcon" class="icon-button" type="button" title="New chat"><span class="icon">+</span></button>
      </div>
    </header>

    <div class="layout">
      <section class="panel provider">
        <div class="section-head">
          <div class="section-title">
            <div class="eyebrow">Provider</div>
            <div class="provider-card">
              <h2>Gemini (Browser)</h2>
              <span class="provider-badge"><span id="providerDot" class="status-dot idle"></span><span id="providerLabel">Idle</span></span>
            </div>
          </div>
          <div id="statusText"></div>
        </div>
        <div class="action-row">
          <button id="newChat" class="primary" type="button">New Chat</button>
          <button id="clearChats" class="danger" type="button">Clear History</button>
        </div>
      </section>

      <section id="historyGrid" class="history-grid">
        <div class="panel" style="display:flex;flex-direction:column;gap:10px;min-height:0;flex:1;">
          <div class="section-head" style="margin-bottom:0;">
            <div class="section-title">
              <div class="eyebrow">Tasks</div>
              <h2>History</h2>
              <div class="history-note">Pick a previous chat and continue from the same state.</div>
            </div>
            <small id="sessionCount">0</small>
          </div>
          <div id="sessions" class="list"></div>
        </div>
      </section>

      <section id="chatGrid" class="chat-grid">
        <section class="chat-card">
          <div class="chat-head">
            <div class="chat-title">
              <div class="eyebrow">AgentFlow</div>
              <h2 id="chatTitle">New chat</h2>
            </div>
            <div class="status-line"><span class="status-dot"></span><span id="chatMeta">0 messages</span></div>
          </div>
          <div class="messages" id="messages"></div>
          <div class="composer">
            <textarea id="prompt" placeholder="Ask Gemini to do anything..."></textarea>
            <div class="composer-row">
              <div class="hint">Enter to send · Shift+Enter for newline</div>
              <button id="send" class="send" type="button">Send</button>
            </div>
          </div>
        </section>
      </section>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const sessions = document.getElementById('sessions');
    const messages = document.getElementById('messages');
    const chatTitle = document.getElementById('chatTitle');
    const chatMeta = document.getElementById('chatMeta');
    const sessionCount = document.getElementById('sessionCount');
    const prompt = document.getElementById('prompt');
    const sendButton = document.getElementById('send');
    const chatTab = document.getElementById('chatTab');
    const historyTab = document.getElementById('historyTab');
    const historyGrid = document.getElementById('historyGrid');
    const chatGrid = document.getElementById('chatGrid');
    const statusText = document.getElementById('statusText');
    const providerDot = document.getElementById('providerDot');
    const providerLabel = document.getElementById('providerLabel');

    let activeView = 'chat';
    let sending = false;

    document.getElementById('newChat').addEventListener('click', () => vscode.postMessage({ type: 'new-chat' }));
    document.getElementById('newChatIcon').addEventListener('click', () => vscode.postMessage({ type: 'new-chat' }));
    document.getElementById('clearChats').addEventListener('click', () => vscode.postMessage({ type: 'clear-chats' }));
    sendButton.addEventListener('click', sendMessage);
    prompt.addEventListener('input', () => { resizePrompt(); syncSendState(); });
    prompt.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
    chatTab.addEventListener('click', () => setView('chat'));
    historyTab.addEventListener('click', () => setView('history'));

    window.addEventListener('message', event => {
      const data = event.data;

      if (data.type === 'sending') {
        sending = data.sending;
        if (sending) {
          providerDot.className = 'status-dot busy';
          providerLabel.textContent = 'Working';
        } else {
          providerDot.className = 'status-dot idle';
          providerLabel.textContent = 'Idle';
        }
        syncSendState();
        return;
      }

      if (data.type === 'status') {
        statusText.textContent = data.status || '';
        return;
      }

      if (data.type !== 'state') return;

      const activeSession = data.activeSession;
      const activeMessages = activeSession?.messages || [];
      chatTitle.textContent = activeSession ? activeSession.title : 'New chat';
      chatMeta.textContent = activeMessages.length + ' message' + (activeMessages.length === 1 ? '' : 's');
      sessionCount.textContent = String(data.sessions.length);

      sessions.innerHTML = '';
      data.sessions.forEach(session => {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'session-item' + (session.id === data.activeSessionId ? ' active' : '');
        node.innerHTML =
          '<div class="session-main">' +
            '<div class="session-title">' + escapeHtml(session.title) + '</div>' +
            '<div class="session-sub">' +
              '<span>gemini-browser</span>' +
              '<span>\u2022</span>' +
              '<span>' + escapeHtml(formatTime(session.updatedAt || session.createdAt)) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="pill">' + session.messages.length + '</div>';
        node.addEventListener('click', () => {
          vscode.postMessage({ type: 'select-session', sessionId: session.id });
          setView('chat');
        });
        sessions.appendChild(node);
      });

      messages.innerHTML = '';
      if (!activeMessages.length) {
        messages.innerHTML =
          '<div class="empty-state">' +
            '<div class="empty-card">' +
              '<div class="empty-icon"></div>' +
              '<div class="eyebrow">Start here</div>' +
              '<h3>Gemini browser agent</h3>' +
              '<p>Send a message and AgentFlow will route it through your gemini.google.com browser session. Tool results are executed locally.</p>' +
              '<div class="chips">' +
                '<button type="button" class="chip" data-prompt="List the files in the current workspace.">List files</button>' +
                '<button type="button" class="chip" data-prompt="Read the main entry point file and explain its structure.">Read entry point</button>' +
                '<button type="button" class="chip" data-prompt="Suggest a refactor for this project."">Suggest refactor</button>' +
              '</div>' +
            '</div>' +
          '</div>';
        attachPromptChips();
      } else {
        activeMessages.forEach(message => {
          const node = document.createElement('div');
          const isError = message.role === 'tool' && message.content.startsWith('Error:');
          node.className = 'msg ' + message.role + (isError ? ' error' : '');
          const label = message.role === 'assistant' ? 'Gemini' : message.role === 'user' ? 'You' : 'Tool';
          node.innerHTML =
            '<div class="msg-label">' + label + '</div>' +
            '<div class="bubble">' + escapeHtml(message.content) + '</div>';
          messages.appendChild(node);
        });
      }

      messages.scrollTop = messages.scrollHeight;
      syncSendState();
    });

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
    }

    function formatTime(timestamp) {
      const diff = Math.max(0, Date.now() - Number(timestamp || Date.now()));
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(diff / 3600000);
      const days = Math.floor(diff / 86400000);
      if (days > 0) return days + 'd ago';
      if (hours > 0) return hours + 'h ago';
      if (minutes > 0) return minutes + 'm ago';
      return 'just now';
    }

    function sendMessage() {
      if (sending) return;
      const content = prompt.value;
      if (!content.trim()) return;
      vscode.postMessage({ type: 'send-message', content });
      prompt.value = '';
      resizePrompt();
      syncSendState();
    }

    function resizePrompt() {
      prompt.style.height = 'auto';
      prompt.style.height = Math.min(prompt.scrollHeight, 180) + 'px';
    }

    function syncSendState() {
      sendButton.disabled = !prompt.value.trim() || sending;
    }

    function attachPromptChips() {
      document.querySelectorAll('[data-prompt]').forEach(node => {
        node.addEventListener('click', () => {
          prompt.value = node.getAttribute('data-prompt') || '';
          resizePrompt();
          prompt.focus();
          syncSendState();
        });
      });
    }

    function setView(view) {
      activeView = view;
      document.body.dataset.view = view;
      chatTab.classList.toggle('active', view === 'chat');
      historyTab.classList.toggle('active', view === 'history');
      chatGrid.style.display = view === 'chat' ? 'flex' : 'none';
      historyGrid.style.display = view === 'history' ? 'flex' : 'none';
    }

    resizePrompt();
    syncSendState();
    setView('chat');
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
