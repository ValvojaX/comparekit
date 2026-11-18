import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { initCompare } from './compare';
import { initFolders } from './folders';
import { registerMemFs } from './memfs';
import { testState, type TestState } from './testState';
import { registerViewers } from './viewers';
import { registerViews } from './views';

export function activate(context: vscode.ExtensionContext): { testState: TestState } | undefined {
  initCompare(context);
  registerMemFs(context);
  initFolders(context);
  registerCommands(context);
  registerViewers(context);
  testState.revisions = registerViews(context);
  return context.extensionMode === vscode.ExtensionMode.Test ? { testState } : undefined;
}

export function deactivate(): void {}
