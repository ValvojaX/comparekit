// Runs the integration suite inside a real VS Code against a scratch git
// repository that has a merge in progress with CSV and Excel conflicts.
//   npm run test:integration            (uses VSCODE_PATH, or downloads VS Code)

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

async function zip(files: Record<string, string>): Promise<Buffer> {
  const z = new JSZip();
  for (const [k, v] of Object.entries(files)) z.file(k, v);
  return Buffer.from(await z.generateAsync({ type: 'uint8array' }));
}

/** Stand-in image bytes: a PNG signature and differing payloads (decoding isn't needed host-side). */
const png = (tag: string) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(tag.repeat(50))]);
import { runTests } from '@vscode/test-electron';

async function xlsx(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function makeRepo(dir: string): Promise<void> {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  const write = (name: string, data: string | Buffer) => writeFileSync(join(dir, name), data);

  write('data.csv', 'id,name,qty\n1,apple,5\n2,pear,3\n3,plum,1\n');
  write('book.xlsx', await xlsx([['id', 'qty'], [1, 5], [2, 3]]));
  write('notes.txt', 'hello\n');
  write('site.zip', await zip({ 'a.txt': '1', 'b.txt': '1' }));
  write('logo.png', png('base'));
  for (const d of ['dirA', 'dirB', 'dirA/sub', 'dirB/sub']) mkdirSync(join(dir, d));
  write('dirA/same.txt', 'same');
  write('dirB/same.txt', 'same');
  write('dirA/sub/diff.txt', 'abcd');
  write('dirB/sub/diff.txt', 'abXd');
  write('dirA/only.txt', 'left');
  write('dirB/new.txt', 'right');
  git('add', '.');
  git('commit', '-q', '-m', 'base');

  git('checkout', '-q', '-b', 'theirs');
  write('data.csv', 'id,name,qty\n1,apple,7\n2,Pear,3\n3,plum,1\n');
  write('book.xlsx', await xlsx([['id', 'qty'], [1, 5], [2, 4], [3, 9]]));
  write('site.zip', await zip({ 'a.txt': '1', 'b.txt': 'theirs', 'c.txt': 'new' }));
  write('logo.png', png('theirs'));
  git('commit', '-q', '-am', 'theirs');

  git('checkout', '-q', 'main');
  write('data.csv', 'id,name,qty\n1,apple,6\n2,pear,3\n3,plum,2\n');
  write('book.xlsx', await xlsx([['id', 'qty'], [1, 6], [2, 3]]));
  write('site.zip', await zip({ 'a.txt': 'ours', 'b.txt': 'ours' }));
  write('logo.png', png('ours'));
  write('main-only.txt', 'only on main\n');
  git('add', 'main-only.txt');
  git('commit', '-q', '-am', 'ours');
  try {
    git('merge', 'theirs');
  } catch {
    // Expected: the merge stops with conflicts.
  }
  // An unstaged edit, for "Open Changes".
  write('notes.txt', 'hello\nworld\n');
}

async function main() {
  const root = resolve(__dirname, '../../..');
  const work = mkdtempSync(join(tmpdir(), 'vscode-compare-it-'));
  const repo = join(work, 'repo');
  mkdirSync(repo);
  await makeRepo(repo);
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH,
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(__dirname, 'suite.js'),
    launchArgs: [repo, '--disable-extensions', '--user-data-dir', join(work, 'user'), '--disable-workspace-trust'],
    extensionTestsEnv: { IT_REPO: repo },
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
