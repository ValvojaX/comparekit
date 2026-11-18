import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { InitPayload } from '../../src/shared/protocol';
import { onHostMessage, post } from './vscode';
import { TableDiffView } from './TableDiffView';
import { TableView } from './TableView';
import { TableMergeView } from './TableMergeView';
import { PictureDiffView } from './PictureDiffView';
import { HexDiffView } from './HexDiffView';
import { ArchiveDiffView, ArchiveMergeView, WholeMergeView } from './ArchiveViews';
import { FolderDiffView } from './FolderDiffView';
import './ui/tokens.css';
import './ui/base.css';
import './ui/minimap.css';
import './ui/table.css';
import './ui/picture.css';
import './ui/hex.css';
import './ui/folder.css';
import './ui/merge.css';
import './ui/extra.css';
import { ErrorState, Spinner } from './ui/ui';

function App() {
  const [payload, setPayload] = useState<InitPayload | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const off = onHostMessage((msg) => {
      if (msg.type === 'init') {
        setPayload(msg.payload);
        setGeneration((g) => g + 1);
      }
    });
    post({ type: 'ready' });
    return off;
  }, []);

  if (!payload) return <Spinner label="Loading" />;
  switch (payload.view) {
    case 'error':
      return <ErrorState error={payload.message} />;
    case 'table-diff':
      return <TableDiffView key={generation} init={payload} />;
    case 'table-view':
      return <TableView init={payload} />;
    case 'table-merge':
      return <TableMergeView key={generation} init={payload} />;
    case 'picture-diff':
      return <PictureDiffView key={generation} init={payload} />;
    case 'hex-diff':
      return <HexDiffView key={generation} init={payload} />;
    case 'archive-diff':
      return <ArchiveDiffView key={generation} init={payload} />;
    case 'archive-merge':
      return <ArchiveMergeView key={generation} init={payload} />;
    case 'folder-diff':
      return <FolderDiffView key={generation} init={payload} />;
    case 'whole-merge':
      return <WholeMergeView key={generation} init={payload} />;
  }
}

createRoot(document.getElementById('root')!).render(<App />);
