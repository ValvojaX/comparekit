// The dispatcher: every compare and merge command ends here. Text goes to VS
// Code's own diff editor and merge editor; other formats open a webview.

import * as vscode from 'vscode';
import { diffArchives, mergeArchives, readEntry, writeArchive } from './core/archive';
import { diffBytes, imageMime, toBase64 } from './core/bytes';
import type { Side as MergeSide } from './core/tablemerge';
import { baseName, detectKind, extensionOf, type ViewKind } from './formats';
import { memUri } from './memfs';
import type { FileDoc, MergeResult, TableFormat, WebviewMessage } from './shared/protocol';
import { readHead, type Side } from './sides';
import { csvOutput, excelOutput, loadTable } from './tables';
import { openPanel, type Handlers } from './webview';

let extensionUri: vscode.Uri;

export function initCompare(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;
}

export async function kindFor(side: Side): Promise<ViewKind> {
  const byName = detectKind(side.uri.path);
  if (byName !== 'text') return byName;
  // Unknown extension: sniff content, so binary files don't open as text.
  return detectKind(side.uri.path, await readHead(side));
}

function tableFormat(kind: ViewKind): TableFormat | undefined {
  return kind === 'table' ? 'csv' : kind === 'excel' ? 'excel' : undefined;
}

function fileDoc(side: Side, bytes: Uint8Array, withImage: boolean): FileDoc {
  return {
    label: side.label,
    detail: side.detail,
    size: bytes.byteLength,
    image: withImage ? { mime: imageMime(extensionOf(side.uri.path)), base64: toBase64(bytes) } : undefined,
  };
}

/** Caches a side's bytes so a webview reload doesn't read the file again. */
function cached(side: Side): Side & { bytes(): Promise<Uint8Array> } {
  let p: Promise<Uint8Array> | undefined;
  const bytes = () => (p ??= side.read());
  return { ...side, read: bytes, bytes };
}

/** A side for one entry of an archive side. */
function entrySide(archive: Side, name: string): Side {
  let uri: vscode.Uri | undefined;
  let data: Promise<Uint8Array> | undefined;
  const read = () => (data ??= archive.read().then((bytes) => readEntry(bytes, name)));
  const side: Side = {
    uri: vscode.Uri.from({ scheme: 'untitled', path: `/${name}` }),
    textUri: vscode.Uri.from({ scheme: 'untitled', path: `/${name}` }),
    label: `${archive.label} › ${name}`,
    version: archive.version,
    detail: `${name} in ${archive.detail}`,
    readonly: true,
    read,
  };
  // The URIs are only known once the entry is read; prepare() fills them in.
  return Object.assign(side, {
    async prepare() {
      uri ??= memUri(name, await read());
      side.uri = uri;
      side.textUri = uri;
    },
  });
}

async function prepared(side: Side): Promise<Side> {
  await (side as Side & { prepare?: () => Promise<void> }).prepare?.();
  return side;
}

export async function openCompare(left: Side, right: Side): Promise<void> {
  [left, right] = await Promise.all([prepared(left), prepared(right)]);
  const kind = await kindFor(left.uri.path === right.uri.path ? left : right);
  const title =
    baseName(left.uri.path) === baseName(right.uri.path) && left.version !== right.version
      ? `${baseName(left.uri.path)} (${left.version} ↔ ${right.version})`
      : `${left.label} ↔ ${right.label}`;
  const format = tableFormat(kind);
  const l = cached(left), r = cached(right);
  const asText = () => void vscode.commands.executeCommand('vscode.diff', left.textUri, right.textUri, title, { preview: false });
  if (format) {
    openPanel(extensionUri, title, async () => ({ view: 'table-diff', left: await loadTable(l, format), right: await loadTable(r, format) }), { onOpenAsText: asText });
    return;
  }
  switch (kind) {
    case 'picture':
      openPanel(extensionUri, title, async () => ({ view: 'picture-diff', left: fileDoc(l, await l.bytes(), true), right: fileDoc(r, await r.bytes(), true) }));
      return;
    case 'binary':
      openPanel(
        extensionUri,
        title,
        async () => {
          const [a, b] = await Promise.all([l.bytes(), r.bytes()]);
          const d = diffBytes(a, b);
          return { view: 'hex-diff', left: fileDoc(l, a, false), right: fileDoc(r, b, false), ...d };
        },
        { onMessage: hexPaging(l, r), onOpenAsText: asText },
      );
      return;
    case 'archive':
      openPanel(
        extensionUri,
        title,
        async () => {
          const [a, b] = await Promise.all([l.bytes(), r.bytes()]);
          return { view: 'archive-diff', left: fileDoc(l, a, false), right: fileDoc(r, b, false), entries: diffArchives(a, b) };
        },
        {
          async onMessage(msg) {
            if (msg.type !== 'openEntry') return;
            await openEntryCompare(l, r, msg.name);
          },
        },
      );
      return;
  }
  await vscode.commands.executeCommand('vscode.diff', left.textUri, right.textUri, title, { preview: false });
}

function hexPaging(l: Side & { bytes(): Promise<Uint8Array> }, r: Side & { bytes(): Promise<Uint8Array> }): Handlers['onMessage'] {
  return async (msg, post) => {
    if (msg.type !== 'readBytes') return;
    const bytes = await (msg.side === 'left' ? l : r).bytes();
    const offset = Math.max(0, Math.min(msg.offset, bytes.length));
    const end = Math.min(bytes.length, offset + Math.min(msg.length, 1 << 20));
    await post({ type: 'bytes', id: msg.id, base64: toBase64(bytes.subarray(offset, end)) });
  };
}

async function openEntryCompare(left: Side, right: Side, name: string): Promise<void> {
  const a = entrySide(left, name), b = entrySide(right, name);
  const [ha, hb] = await Promise.all([a.read().then(() => true, () => false), b.read().then(() => true, () => false)]);
  if (ha && hb) return openCompare(a, b);
  const only = await prepared(ha ? a : b);
  await vscode.commands.executeCommand('vscode.open', only.uri, { preview: true });
}

export interface MergeSources {
  base: Side | null;
  ours: Side | null;
  theirs: Side | null;
  /** Where the result is written. */
  output: vscode.Uri;
  /** Called after a successful save (for example, to stage the file). */
  afterSave?: () => Promise<void>;
}

/** Opens the merge view for a non-text file. Returns false for text. */
export async function openMerge(src: MergeSources): Promise<boolean> {
  const any = (src.ours ?? src.theirs ?? src.base)!;
  const kind = await kindFor(any);
  if (kind === 'text') return false;
  const sides: Record<MergeSide, (Side & { bytes(): Promise<Uint8Array> }) | null> = {
    base: src.base && cached(src.base),
    ours: src.ours && cached(src.ours),
    theirs: src.theirs && cached(src.theirs),
  };
  const bytesOf = async () => {
    const out: Partial<Record<MergeSide, Uint8Array>> = {};
    for (const k of ['base', 'ours', 'theirs'] as MergeSide[]) if (sides[k]) out[k] = await sides[k]!.bytes();
    return out;
  };
  const title = `Merge: ${baseName(any.uri.path)}`;
  const outputLabel = vscode.workspace.asRelativePath(src.output);
  const onSave: Handlers['onSave'] = async (msg) => {
    await writeMergeResult(msg.result, await bytesOf(), src);
    // Not awaited: the notification stays until dismissed, and the save is already done.
    const stage = src.afterSave ? 'Mark as Resolved' : undefined;
    void vscode.window
      .showInformationMessage(`Merged result saved to ${outputLabel}.`, ...(stage ? [stage] : []))
      .then((pick) => (pick && pick === stage ? src.afterSave?.() : undefined));
  };
  const compareSides = async (msg: WebviewMessage) => {
    if (msg.type === 'compareSides' && sides[msg.a] && sides[msg.b]) await openCompare(sides[msg.a]!, sides[msg.b]!);
    if (msg.type === 'compareEntry' && sides[msg.a] && sides[msg.b]) await openEntryCompare(sides[msg.a]!, sides[msg.b]!, msg.name);
  };

  const format = tableFormat(kind);
  if (format && sides.ours && sides.theirs) {
    openPanel(
      extensionUri,
      title,
      async () => {
        const load = (k: MergeSide) => (sides[k] ? loadTable(sides[k]!, format) : Promise.resolve(null));
        const [base, ours, theirs] = await Promise.all([load('base'), load('ours'), load('theirs')]);
        return { view: 'table-merge', format, base, ours, theirs, outputLabel };
      },
      { onSave, onMessage: compareSides },
    );
    return true;
  }
  if (kind === 'archive' && sides.ours && sides.theirs) {
    openPanel(
      extensionUri,
      title,
      async () => {
        const b = await bytesOf();
        return {
          view: 'archive-merge',
          base: sides.base ? fileDoc(sides.base, b.base!, false) : null,
          ours: fileDoc(sides.ours!, b.ours!, false),
          theirs: fileDoc(sides.theirs!, b.theirs!, false),
          entries: mergeArchives(b.base ?? null, b.ours!, b.theirs!),
          outputLabel,
        };
      },
      { onSave, onMessage: compareSides },
    );
    return true;
  }
  // Images, other binaries, and one-sided conflicts: pick a whole file.
  const picture = kind === 'picture';
  openPanel(
    extensionUri,
    title,
    async () => {
      const b = await bytesOf();
      const doc = (k: MergeSide) => (sides[k] ? fileDoc(sides[k]!, b[k]!, picture) : null);
      return { view: 'whole-merge', kind: picture ? 'picture' : 'binary', base: doc('base'), ours: doc('ours'), theirs: doc('theirs'), outputLabel };
    },
    { onSave, onMessage: compareSides },
  );
  return true;
}

async function writeMergeResult(result: MergeResult, bytes: Partial<Record<MergeSide, Uint8Array>>, src: MergeSources): Promise<void> {
  let out: Uint8Array;
  switch (result.format) {
    case 'whole':
      if (result.take === 'delete') {
        await vscode.workspace.fs.delete(src.output, { useTrash: true });
        return;
      }
      if (!bytes[result.take]) throw new Error(`There is no ${result.take} version of this file.`);
      out = bytes[result.take]!;
      break;
    case 'csv':
      out = csvOutput(result.rows, bytes.ours ?? bytes.theirs, src.output.path);
      break;
    case 'excel':
      out = await excelOutput(bytes, result.sheets);
      break;
    case 'archive':
      out = await writeArchive(bytes, result.entries);
      break;
  }
  await vscode.workspace.fs.writeFile(src.output, out);
}
