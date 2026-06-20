export type ProviderId = 'gemini-browser';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  provider: ProviderId;
  messages: ChatMessage[];
}

export type ToolName = 'list_files' | 'read_file' | 'write_file' | 'run_command';

export interface ToolRequest {
  tool: ToolName;
  path?: string;
  content?: string;
  command?: string;
}
