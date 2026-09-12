import * as vscode from 'vscode';
import { Store } from './store';

/**
 * The persistent launch surface. VS Code has no dock icon, so a status bar item
 * is the closest equivalent: always visible, one click to the manager, and it
 * answers "is anything about to run?" without opening anything.
 */
export class StatusItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly listener: vscode.Disposable;

  constructor(private readonly store: Store) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'synchrony.openManager';
    this.item.name = 'Synchrony';
    this.listener = store.onDidChange(() => this.refresh());
    this.refresh();
    this.item.show();
  }

  dispose(): void {
    this.listener.dispose();
    this.item.dispose();
  }

  /** Running beats upcoming: what is happening now matters more than what is next. */
  refresh(): void {
    const runs = this.store.getRuns();
    const running = runs.filter((r) => r.status === 'running').length;
    const missed = runs.filter((r) => r.status === 'missed').length;

    if (running > 0) {
      this.item.text = `$(sync~spin) Synchrony ${running}`;
      this.item.tooltip = `${running} task${running > 1 ? 's' : ''} running`;
      this.item.backgroundColor = undefined;
      return;
    }

    if (missed > 0) {
      this.item.text = `$(warning) Synchrony ${missed}`;
      this.item.tooltip = `${missed} missed task${missed > 1 ? 's' : ''} awaiting a decision`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    this.item.backgroundColor = undefined;

    const next = this.store
      .getSeries()
      .filter((s) => s.enabled && !s.spent)
      .map((s) => s.nextRunAt)
      .sort()[0];

    if (!next) {
      this.item.text = '$(clock) Synchrony';
      this.item.tooltip = 'No scheduled tasks — click to open the manager';
      return;
    }

    const when = new Date(next);
    const today = when.toDateString() === new Date().toDateString();
    this.item.text = `$(clock) ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    this.item.tooltip = `Next Synchrony task ${today ? 'today' : when.toLocaleDateString()} at ${when.toLocaleTimeString()}`;
  }
}
