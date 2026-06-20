import { ChatMessage } from '../types';

export interface AgentProvider {
  readonly id: string;
  readonly label: string;
  send(messages: ChatMessage[]): Promise<string>;
  dispose(): Promise<void>;
}
