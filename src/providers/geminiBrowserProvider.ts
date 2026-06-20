import * as fs from 'fs';
import * as path from 'path';
import { AgentProvider } from './provider';
import { ChatMessage } from '../types';

let puppeteer: any;
try {
  puppeteer = require('puppeteer-core');
} catch {
  puppeteer = null;
}

export class GeminiBrowserProvider implements AgentProvider {
  readonly id = 'gemini-browser';
  readonly label = 'Gemini (Browser)';

  private browser: any = null;
  private page: any = null;
  private userDataDir = '';
  private sessionMessagesCount = 0;

  constructor(globalStoragePath: string) {
    this.userDataDir = path.join(globalStoragePath, 'gemini-profile');
  }

  private findChrome(): string | undefined {
    const la = process.env.LOCALAPPDATA || '';
    const pf = process.env.PROGRAMFILES || '';
    const pf86 = process.env['PROGRAMFILES(X86)'] || '';

    const candidates = [
      path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(la, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];

    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }
    return undefined;
  }

  private async ensureBrowser(): Promise<void> {
    if (this.page) {
      try {
        await this.page.evaluate(() => 1);
        return;
      } catch {
        await this.closeBrowser();
      }
    }

    if (!puppeteer) {
      throw new Error(
        'Missing dependency. Please run: npm install puppeteer-core'
      );
    }

    const chromePath = this.findChrome();
    if (!chromePath) {
      throw new Error(
        'Google Chrome or Microsoft Edge not found. Install one to use the Gemini browser provider.'
      );
    }

    fs.mkdirSync(this.userDataDir, { recursive: true });

    try {
      this.browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: false,
        userDataDir: this.userDataDir,
        defaultViewport: null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      });

      this.browser.on('disconnected', () => {
        this.browser = null;
        this.page = null;
        this.sessionMessagesCount = 0;
      });

      const pages = await this.browser.pages();
      this.page = pages[0] || (await this.browser.newPage());
      this.sessionMessagesCount = 0;
    } catch (err) {
      this.browser = null;
      this.page = null;
      throw new Error(
        `Failed to launch browser: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async navigateToGemini(): Promise<void> {
    const url = this.page.url();
    if (url.startsWith('https://gemini.google.com/')) return;

    await this.page.goto('https://gemini.google.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    await this.page.waitForTimeout(2000);
  }

  private async ensureLoggedIn(): Promise<void> {
    const status = await this.page.evaluate(() => {
      const hasEditor = !!document.querySelector(
        'div.ql-editor[contenteditable="true"], [contenteditable="true"], [role="textbox"][contenteditable]'
      );
      if (hasEditor) return 'ok';

      const signInDetected = !!document.querySelector(
        'a[href*="SignIn"], a[href*="signin"], input[type="email"], [data-test-id*="signin"]'
      );
      if (signInDetected) return 'sign-in-required';

      return 'unknown';
    });

    if (status === 'sign-in-required') {
      throw new Error(
        'Not signed in to Google. Please sign in to gemini.google.com in the opened browser window, then send your message again.'
      );
    }

    if (status === 'unknown') {
      await this.page.waitForTimeout(3000);
      const hasEditor = await this.page.evaluate(
        () =>
          !!document.querySelector(
            'div.ql-editor[contenteditable="true"], [contenteditable="true"], [role="textbox"][contenteditable]'
          )
      );
      if (!hasEditor) {
        throw new Error(
          'Could not detect the Gemini chat interface. Make sure you are signed in at gemini.google.com.'
        );
      }
    }
  }

  async send(messages: ChatMessage[]): Promise<string> {
    await this.ensureBrowser();
    await this.navigateToGemini();
    await this.ensureLoggedIn();

    const lastMsg = [...messages]
      .reverse()
      .find((m) => m.role === 'user' || m.role === 'tool');
    if (!lastMsg) throw new Error('No user or tool message to send.');

    const textToSend =
      lastMsg.role === 'tool'
        ? `[Tool result]\n${lastMsg.content}`
        : lastMsg.content;

    const editorSelectors = [
      'div.ql-editor[contenteditable="true"]',
      '[contenteditable="true"]',
      '[role="textbox"][contenteditable]',
      'textarea',
    ];

    const injected = await this.page.evaluate(
      ({ text, selectors }: { text: string; selectors: string[] }) => {
        let editor: HTMLElement | null = null;
        for (const s of selectors) {
          editor = document.querySelector(s);
          if (editor) break;
        }
        if (!editor) throw new Error('Editor not found');

        editor.focus();

        if (editor.tagName === 'TEXTAREA') {
          (editor as HTMLTextAreaElement).value = text;
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          const escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
          editor.innerHTML = `<p>${escaped}</p>`;
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      },
      { text: textToSend, selectors: editorSelectors }
    );

    if (!injected) {
      throw new Error('Could not type into the Gemini input field.');
    }

    await this.page.waitForTimeout(800);

    const sendSelectors = [
      'button[aria-label*="Send" i]',
      'button[aria-label*="send" i]',
      'button.send-button',
      '[data-testid*="send"]',
      'button[data-tooltip*="Send" i]',
      'button mat-icon[fonticon="send"]',
    ];

    const clicked = await this.page.evaluate((selectors: string[]) => {
      for (const s of selectors) {
        const btn = document.querySelector(s) as HTMLButtonElement | null;
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
      }
      return false;
    }, sendSelectors);

    if (!clicked) {
      await this.page.keyboard.press('Enter');
    }

    await this.page.waitForTimeout(1000);

    try {
      await this.page.waitForSelector('button[aria-label*="Stop" i]', {
        timeout: 5000,
      });
    } catch {
    }

    try {
      await this.page.waitForFunction(
        () => !document.querySelector('button[aria-label*="Stop" i]'),
        { timeout: 120000, polling: 500 }
      );
    } catch {
    }

    await this.page.waitForTimeout(1000);

    const responseText = await this.page.evaluate(() => {
      const responseSelectors = [
        '.model-response-text',
        '.response-content',
        'model-response .text',
        '[class*="message-content"]',
        '[class*="response"]',
      ];

      for (const s of responseSelectors) {
        const elements = document.querySelectorAll(s);
        if (elements.length > 0) {
          const last = elements[elements.length - 1] as HTMLElement;
          const text = last.innerText || last.textContent || '';
          if (text.trim()) return text.trim();
        }
      }

      const chatMessages = document.querySelectorAll(
        '[class*="conversation"] [class*="message"], [class*="chat"] [class*="message"]'
      );
      if (chatMessages.length > 0) {
        const last = chatMessages[chatMessages.length - 1] as HTMLElement;
        const text = last.innerText || last.textContent || '';
        if (text.trim()) return text.trim();
      }

      return 'No response could be read from Gemini.';
    });

    this.sessionMessagesCount++;
    return responseText;
  }

  private async closeBrowser(): Promise<void> {
    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch {
    }
    this.browser = null;
    this.page = null;
    this.sessionMessagesCount = 0;
  }

  async dispose(): Promise<void> {
    await this.closeBrowser();
  }
}
