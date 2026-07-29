import * as vscode from 'vscode';
import { OllamaClient } from './ollamaClient.js';

export class OllamaController {
  private static readonly secretKey = 'gitloupe.ollama.apiKey';

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly git: {
      diffWorking(root: string, staged: boolean): Promise<string>;
      commitDetails(root: string, hash: string): Promise<{ subject: string; body: string; files: Array<{ path: string }> }>;
    }
  ) {}

  async chooseModel(): Promise<void> {
    const client = await this.client();
    const models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading local Ollama models…', cancellable: true },
      (_, token) => client.listModels(abortSignal(token))
    );
    if (!models.length) throw new Error('No Ollama models are installed on the configured endpoint.');
    const model = await vscode.window.showQuickPick(models, { title: 'GitLoupe: Select Ollama model' });
    if (model) await vscode.workspace.getConfiguration('gitloupe').update('ollama.model', model, vscode.ConfigurationTarget.Global);
  }

  async setApiKey(): Promise<void> {
    const key = await vscode.window.showInputBox({
      title: 'GitLoupe: Ollama gateway API key',
      prompt: 'Optional. Stored in VS Code SecretStorage; local Ollama normally needs no key.',
      password: true,
      ignoreFocusOut: true
    });
    if (key === undefined) return;
    if (key) await this.secrets.store(OllamaController.secretKey, key);
    else await this.secrets.delete(OllamaController.secretKey);
    void vscode.window.showInformationMessage(key ? 'GitLoupe: Ollama API key saved securely.' : 'GitLoupe: Ollama API key removed.');
  }

  async generateCommitMessage(root: string): Promise<string> {
    const diff = await this.git.diffWorking(root, true);
    if (!diff.trim()) throw new Error('Stage changes before generating a commit message.');
    return this.run(
      'You write concise Git commit messages. Return only the commit message: an imperative subject under 72 characters, then an optional blank line and short body.',
      boundedDiff(diff)
    );
  }

  async explainWorkingChanges(root: string): Promise<string> {
    const [staged, unstaged] = await Promise.all([
      this.git.diffWorking(root, true),
      this.git.diffWorking(root, false)
    ]);
    if (!staged.trim() && !unstaged.trim()) throw new Error('The working tree has no tracked changes.');
    return this.run(
      'Explain code changes for a developer. Summarize intent, important behavior changes, risks, and suggested verification. Use compact Markdown.',
      boundedDiff(`STAGED\n${staged}\n\nUNSTAGED\n${unstaged}`)
    );
  }

  async explainCommit(root: string, hash: string): Promise<string> {
    const details = await this.git.commitDetails(root, hash);
    const summary = `${details.subject}\n${details.body}\nFiles:\n${details.files.map(file => file.path).join('\n')}`;
    return this.run(
      'Explain this Git commit for a code reviewer. Summarize intent, affected areas, likely risks, and verification ideas. Use compact Markdown.',
      summary
    );
  }

  private async run(system: string, prompt: string): Promise<string> {
    const client = await this.client();
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Asking local Ollama…', cancellable: true },
      (_, token) => client.chat(system, prompt, abortSignal(token))
    );
  }

  private async client(): Promise<OllamaClient> {
    const config = vscode.workspace.getConfiguration('gitloupe.ollama');
    return new OllamaClient({
      endpoint: config.get('endpoint', 'http://127.0.0.1:11434'),
      model: config.get('model', ''),
      apiKey: await this.secrets.get(OllamaController.secretKey),
      timeoutMs: config.get('timeoutMs', 120_000)
    });
  }
}

function abortSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort(new Error('Cancelled.')));
  return controller.signal;
}

function boundedDiff(diff: string): string {
  const limit = vscode.workspace.getConfiguration('gitloupe.ollama').get('maxDiffCharacters', 100_000);
  return diff.length <= limit ? diff : `${diff.slice(0, limit)}\n\n[Diff truncated by GitLoupe]`;
}
