import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ToolRequest } from '../types';

const execAsync = promisify(exec);

export class ToolExecutor {
  constructor(private readonly workspaceRoot: string) {}

  async run(request: ToolRequest): Promise<string> {
    switch (request.tool) {
      case 'list_files':
        return this.listFiles(request.path ?? '.');
      case 'read_file':
        return this.readFile(request.path ?? '');
      case 'write_file':
        return this.writeFile(request.path ?? '', request.content ?? '');
      case 'run_command':
        return this.runCommand(request.command ?? '');
      default:
        return `Unknown tool: ${request.tool}`;
    }
  }

  private resolveWorkspacePath(inputPath: string): string {
    const root = path.resolve(this.workspaceRoot);
    const resolved = path.resolve(root, inputPath);
    if (!resolved.startsWith(root)) {
      throw new Error('Path escapes the workspace root.');
    }
    return resolved;
  }

  private async listFiles(inputPath: string): Promise<string> {
    const resolved = this.resolveWorkspacePath(inputPath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    return entries
      .map((entry) => `${entry.isDirectory() ? '[dir] ' : '[file] '}${entry.name}`)
      .join('\n');
  }

  private async readFile(inputPath: string): Promise<string> {
    const resolved = this.resolveWorkspacePath(inputPath);
    return fs.readFile(resolved, 'utf8');
  }

  private async writeFile(inputPath: string, content: string): Promise<string> {
    const approval = await vscode.window.showWarningMessage(
      `Allow AgentFlow to write ${inputPath}?`,
      { modal: true },
      'Allow',
      'Deny',
    );

    if (approval !== 'Allow') {
      return `Write denied for ${inputPath}.`;
    }

    const resolved = this.resolveWorkspacePath(inputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
    return `Wrote ${inputPath}.`;
  }

  private async runCommand(command: string): Promise<string> {
    const approval = await vscode.window.showWarningMessage(
      `Allow AgentFlow to run: ${command}`,
      { modal: true },
      'Allow',
      'Deny',
    );

    if (approval !== 'Allow') {
      return `Command denied: ${command}`;
    }

    const result = await execAsync(command, {
      cwd: this.workspaceRoot,
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 2,
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    return output.trim() || 'Command completed.';
  }
}
