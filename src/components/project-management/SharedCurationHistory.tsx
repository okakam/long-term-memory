'use client';

import { useEffect, useState } from 'react';

type Archive = { memory_id: string; name: string; type: string; current_hash: string };
type Revision = { id: string; created_at: string; reason_code: string };
type SelectedMemory = {
  memory_id: string;
  name: string;
  status: 'active' | 'archived';
  current_hash: string;
  revisions: Revision[];
  next_revision_after: string | null;
};
type RestoreRequest = {
  id: string;
  memory_id: string;
  revision_id: string;
  state: 'pending' | 'succeeded' | 'failed';
  requested_at: string;
  completed_at?: string;
  failure_reason?: string;
};
type HistoryResponse = { archives: Archive[]; selected_memory: SelectedMemory | null };

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw new Error((await response.text()) || fallback);
  return response.json() as Promise<T>;
}

export function SharedCurationHistory() {
  const [archives, setArchives] = useState<Archive[]>([]);
  const [selectedMemory, setSelectedMemory] = useState<SelectedMemory | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [requests, setRequests] = useState<RestoreRequest[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = '/api/projects/__shared__/maintenance';

  async function reloadRequests() {
    const result = await fetch(`${base}/restore-requests`, { cache: 'no-store' })
      .then((response) => parseResponse<{ requests: RestoreRequest[] }>(response, '復元requestを読み込めませんでした。'));
    setRequests(result.requests);
  }

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch(`${base}/history`, { cache: 'no-store', signal: controller.signal })
        .then((response) => parseResponse<HistoryResponse>(response, '共有履歴を読み込めませんでした。')),
      fetch(`${base}/restore-requests`, { cache: 'no-store', signal: controller.signal })
        .then((response) => parseResponse<{ requests: RestoreRequest[] }>(response, '復元requestを読み込めませんでした。')),
    ]).then(([history, result]) => {
      if (controller.signal.aborted) return;
      setArchives(history.archives);
      setRequests(result.requests);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '共有履歴を読み込めませんでした。');
    });
    return () => controller.abort();
  }, [base]);

  async function loadMemory(memoryId: string) {
    setSelectedId(memoryId);
    setSelectedMemory(null);
    setError(null);
    if (!memoryId) return;
    setPending(true);
    try {
      const query = new URLSearchParams({ memory_id: memoryId });
      const history = await fetch(`${base}/history?${query}`, { cache: 'no-store' })
        .then((response) => parseResponse<HistoryResponse>(response, 'revisionを読み込めませんでした。'));
      setSelectedMemory(history.selected_memory);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'revisionを読み込めませんでした。');
    } finally {
      setPending(false);
    }
  }

  async function requestRestore(revisionId: string) {
    if (!selectedMemory) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await fetch(`${base}/restore-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          memory_id: selectedMemory.memory_id,
          revision_id: revisionId,
          expected_hash: selectedMemory.current_hash,
        }),
      }).then((response) => parseResponse(response, '復元requestを作成できませんでした。'));
      await reloadRequests();
      setNotice('共有curatorへ復元を依頼しました。次のwrite実行後に状態が更新されます。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '復元requestを作成できませんでした。');
    } finally {
      setPending(false);
    }
  }

  return <section className="maintenance-panel" aria-labelledby="shared-curation-history-heading">
    <div className="section-heading"><div><p className="eyebrow">SHARED MEMORY</p><h3 id="shared-curation-history-heading">共通記憶の履歴・復元</h3></div></div>
    <p className="muted">共有記憶の復元はcuratorに依頼され、次のwrite実行時に認証を再確認して処理されます。</p>
    {archives.length === 0 ? <p className="muted">共有projectにarchiveはありません。</p> : <>
      <label htmlFor="shared-memory-archive">復元する共有記憶</label>
      <select id="shared-memory-archive" value={selectedId} onChange={(event) => void loadMemory(event.target.value)}>
        <option value="">archiveを選択</option>
        {archives.map((archive) => <option key={archive.memory_id} value={archive.memory_id}>{archive.name} ({archive.type})</option>)}
      </select>
    </>}
    {selectedMemory ? <div className="maintenance-revisions">
      <p className="muted">{selectedMemory.name} / status: {selectedMemory.status}</p>
      {selectedMemory.revisions.length === 0 ? <p className="muted">復元可能なrevisionはありません。</p> : <ul>
        {selectedMemory.revisions.map((revision) => <li key={revision.id}>
          <span>{revision.created_at} / {revision.reason_code}</span>
          <button className="secondary" type="button" disabled={pending || selectedMemory.status !== 'archived'} onClick={() => void requestRestore(revision.id)}>
            復元を依頼
          </button>
        </li>)}
      </ul>}
    </div> : null}
    <section className="maintenance-history" aria-label="共有復元requestの状態">
      <h4>復元request</h4>
      {requests.length === 0 ? <p className="muted">復元requestはありません。</p> : <ul className="maintenance-events">
        {requests.map((request) => <li key={request.id}>
          {request.memory_id} / revision {request.revision_id} / {request.state}
          {request.failure_reason ? ` (${request.failure_reason})` : ''}
          <time dateTime={request.completed_at ?? request.requested_at}> / {request.completed_at ?? request.requested_at}</time>
        </li>)}
      </ul>}
    </section>
    {notice ? <p className="success-message" role="status">{notice}</p> : null}
    {error ? <p className="error-message" role="alert">{error}</p> : null}
  </section>;
}
