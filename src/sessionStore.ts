import * as vscode from 'vscode';
import { ProviderId, Session } from './types';

const STORAGE_KEY = 'agentflow.sessions';
const ACTIVE_SESSION_KEY = 'agentflow.activeSessionId';

export class SessionStore {
  constructor(private readonly state: vscode.Memento) {}

  list(): Session[] {
    return this.state.get<Session[]>(STORAGE_KEY, []);
  }

  getActiveSessionId(): string | undefined {
    return this.state.get<string | undefined>(ACTIVE_SESSION_KEY);
  }

  setActiveSessionId(sessionId: string | undefined): Thenable<void> {
    return this.state.update(ACTIVE_SESSION_KEY, sessionId);
  }

  get(id: string): Session | undefined {
    return this.list().find((session) => session.id === id);
  }

  save(sessions: Session[]): Thenable<void> {
    return this.state.update(STORAGE_KEY, sessions);
  }

  create(provider: ProviderId): Session {
    return {
      id: Date.now().toString(),
      title: 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider,
      messages: [{ role: 'system', content: 'You are AgentFlow.' }],
    };
  }

  upsert(session: Session): Thenable<void> {
    const sessions = this.list();
    const index = sessions.findIndex((item) => item.id === session.id);
    if (index >= 0) sessions[index] = session;
    else sessions.unshift(session);
    return this.save(sessions.slice(0, 30));
  }

  clear(): Thenable<void> {
    return Promise.all([
      this.state.update(STORAGE_KEY, []),
      this.state.update(ACTIVE_SESSION_KEY, undefined),
    ]).then(() => undefined);
  }
}
