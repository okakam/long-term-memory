'use client';

import { type FormEvent, useEffect, useState } from 'react';

import { DEFAULT_MAINTENANCE_SETTINGS } from '@/lib/maintenance/policy';
import { MaintenanceSettingsSchema, type MaintenanceSettings } from '@/lib/maintenance/types';

type Archive = {
  memory_id: string;
  name: string;
  description: string;
  type: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  archive_reason: string | null;
  current_hash: string;
};

type Revision = {
  id: string;
  memory_id: string;
  content_hash: string;
  created_at: string;
  operation_id: string;
  reason_code: string;
};

type Event = {
  operation_id: string;
  action: string;
  reason_code: string;
  created_at: string;
};

type SelectedMemory = {
  memory_id: string;
  name: string;
  status: 'active' | 'archived';
  current_hash: string;
  revisions: Revision[];
  next_revision_after: string | null;
};

type HistoryResponse = {
  events: Event[];
  next_event_after: string | null;
  archives: Archive[];
  next_archive_after: string | null;
  selected_memory: SelectedMemory | null;
};

type MaintenancePanelProps = { projectId: string };

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || fallback);
  }
  return response.json() as Promise<T>;
}

async function fetchInitialData(base: string, signal?: AbortSignal): Promise<{ settings: MaintenanceSettings; history: HistoryResponse }> {
  const [settings, history] = await Promise.all([
    fetch(base, { signal, cache: 'no-store' }).then((response) => parseResponse<MaintenanceSettings>(response, '設定を読み込めませんでした。')),
    fetch(`${base}/history`, { signal, cache: 'no-store' }).then((response) => parseResponse<HistoryResponse>(response, '履歴を読み込めませんでした。')),
  ]);
  return { settings: MaintenanceSettingsSchema.parse(settings), history };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function MaintenancePanel({ projectId }: MaintenancePanelProps) {
  const [settings, setSettings] = useState<MaintenanceSettings>(() => ({
    ...DEFAULT_MAINTENANCE_SETTINGS,
    review_days: { ...DEFAULT_MAINTENANCE_SETTINGS.review_days },
  }));
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [events, setEvents] = useState<Event[]>([]);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [nextEventAfter, setNextEventAfter] = useState<string | null>(null);
  const [nextArchiveAfter, setNextArchiveAfter] = useState<string | null>(null);
  const [selectedMemory, setSelectedMemory] = useState<SelectedMemory | null>(null);
  const [selectedArchiveId, setSelectedArchiveId] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base = `/api/projects/${encodeURIComponent(projectId)}/maintenance`;

  function applyInitialData(data: { settings: MaintenanceSettings; history: HistoryResponse }) {
    setSettings(data.settings);
    setSettingsLoaded(true);
    setEvents(data.history.events);
    setArchives(data.history.archives);
    setNextEventAfter(data.history.next_event_after);
    setNextArchiveAfter(data.history.next_archive_after);
    setSelectedMemory(null);
    setSelectedArchiveId('');
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetchInitialData(base, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setSettings(data.settings);
      setSettingsLoaded(true);
      setEvents(data.history.events);
      setArchives(data.history.archives);
      setNextEventAfter(data.history.next_event_after);
      setNextArchiveAfter(data.history.next_archive_after);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(errorText(cause, '自動棚卸し情報を読み込めませんでした。'));
    });
    return () => controller.abort();
  }, [base]);

  function changeReviewDays(type: keyof MaintenanceSettings['review_days'], value: string) {
    const days = Number(value);
    setSettings((current) => current ? { ...current, review_days: { ...current.review_days, [type]: days } } : current);
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    setPending('settings');
    setError(null);
    setNotice(null);
    try {
      const payload = MaintenanceSettingsSchema.parse(settings);
      const response = await fetch(base, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const saved = await parseResponse<MaintenanceSettings>(response, '設定を保存できませんでした。');
      setSettings(saved);
      setNotice('設定を保存しました。変更は次回の棚卸しから適用されます。');
    } catch (cause) {
      setError(errorText(cause, '設定を保存できませんでした。'));
    } finally {
      setPending(null);
    }
  }

  async function loadSelectedMemory(memoryId: string) {
    setSelectedArchiveId(memoryId);
    setSelectedMemory(null);
    if (!memoryId) return;
    setPending('history');
    setError(null);
    try {
      const url = `${base}/history?memory_id=${encodeURIComponent(memoryId)}`;
      const history = await fetch(url, { cache: 'no-store' }).then((response) => parseResponse<HistoryResponse>(response, 'revisionを読み込めませんでした。'));
      setSelectedMemory(history.selected_memory);
    } catch (cause) {
      setError(errorText(cause, 'revisionを読み込めませんでした。'));
    } finally {
      setPending(null);
    }
  }

  async function loadMoreEvents() {
    if (!nextEventAfter) return;
    setPending('events');
    setError(null);
    try {
      const url = `${base}/history?after=${encodeURIComponent(nextEventAfter)}`;
      const history = await fetch(url, { cache: 'no-store' }).then((response) => parseResponse<HistoryResponse>(response, '履歴を読み込めませんでした。'));
      setEvents((current) => [...current, ...history.events]);
      setNextEventAfter(history.next_event_after);
    } catch (cause) {
      setError(errorText(cause, '履歴を読み込めませんでした。'));
    } finally {
      setPending(null);
    }
  }

  async function loadMoreArchives() {
    if (!nextArchiveAfter) return;
    setPending('archives');
    setError(null);
    try {
      const url = `${base}/history?archive_after=${encodeURIComponent(nextArchiveAfter)}`;
      const history = await fetch(url, { cache: 'no-store' }).then((response) => parseResponse<HistoryResponse>(response, 'archive一覧を読み込めませんでした。'));
      setArchives((current) => [...current, ...history.archives]);
      setNextArchiveAfter(history.next_archive_after);
    } catch (cause) {
      setError(errorText(cause, 'archive一覧を読み込めませんでした。'));
    } finally {
      setPending(null);
    }
  }

  async function loadMoreRevisions() {
    if (!selectedMemory?.next_revision_after) return;
    setPending('revisions');
    setError(null);
    try {
      const query = new URLSearchParams({
        memory_id: selectedMemory.memory_id,
        revision_after: selectedMemory.next_revision_after,
      });
      const history = await fetch(`${base}/history?${query}`, { cache: 'no-store' })
        .then((response) => parseResponse<HistoryResponse>(response, 'revisionを読み込めませんでした。'));
      if (history.selected_memory) {
        setSelectedMemory((current) => current ? {
          ...current,
          revisions: [...current.revisions, ...history.selected_memory!.revisions],
          next_revision_after: history.selected_memory!.next_revision_after,
        } : current);
      }
    } catch (cause) {
      setError(errorText(cause, 'revisionを読み込めませんでした。'));
    } finally {
      setPending(null);
    }
  }

  async function restoreRevision(revisionId: string) {
    if (!selectedMemory) return;
    setPending(revisionId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${base}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          memory_id: selectedMemory.memory_id,
          revision_id: revisionId,
          expected_hash: selectedMemory.current_hash,
          operation_id: globalThis.crypto.randomUUID(),
        }),
      });
      await parseResponse(response, '復元できませんでした。');
      setNotice('revisionから復元しました。記憶はactiveになりました。');
      applyInitialData(await fetchInitialData(base));
    } catch (cause) {
      setError(errorText(cause, '復元できませんでした。'));
    } finally {
      setPending(null);
    }
  }

  return <section className="maintenance-panel" aria-labelledby="maintenance-heading">
    <div className="section-heading"><div><p className="eyebrow">MEMORY MAINTENANCE</p><h3 id="maintenance-heading">自動棚卸し</h3></div></div>
    <>
      <p className="muted" aria-live="polite">{settingsLoaded
        ? <>実行状態: {settings.enabled ? '有効' : '無効'} / 最終処理: {events[0] ? `${events[0].action}・${events[0].created_at}` : 'まだありません'}</>
        : '設定を読み込んでいます…'}</p>
      <form className="maintenance-settings" onSubmit={saveSettings}>
        <label className="maintenance-enabled"><input type="checkbox" checked={settings.enabled} disabled={!settingsLoaded || pending !== null} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} />自動棚卸しを有効にする</label>
        <fieldset>
          <legend>review日数</legend>
          <div className="maintenance-days-grid">
            {(['project', 'reference', 'user', 'feedback'] as const).map((type) => <label key={type}>
              {type}
              <input type="number" min="1" max="3650" required disabled={!settingsLoaded || pending !== null} value={settings.review_days[type]} onChange={(event) => changeReviewDays(type, event.target.value)} />
            </label>)}
            <label>session archive日数
              <input type="number" min="1" max="3650" required disabled={!settingsLoaded || pending !== null} value={settings.session_archive_days} onChange={(event) => setSettings({ ...settings, session_archive_days: Number(event.target.value) })} />
            </label>
          </div>
        </fieldset>
        <button className="primary" type="submit" disabled={!settingsLoaded || pending !== null}>{pending === 'settings' ? '保存中…' : '設定を保存'}</button>
      </form>
    </>

    <section className="maintenance-history" aria-labelledby="maintenance-history-heading">
      <h4 id="maintenance-history-heading">archiveとrevision履歴</h4>
      {archives.length === 0 ? <p className="muted">archiveされた記憶はありません。</p> : <>
        <label htmlFor="maintenance-archive">復元する記憶</label>
        <select id="maintenance-archive" value={selectedArchiveId} onChange={(event) => void loadSelectedMemory(event.target.value)}>
          <option value="">archiveを選択</option>
          {archives.map((archive) => <option key={archive.memory_id} value={archive.memory_id}>{archive.name} ({archive.type})</option>)}
        </select>
        {nextArchiveAfter ? <button className="secondary" type="button" disabled={pending !== null} onClick={() => void loadMoreArchives()}>さらにarchiveを表示</button> : null}
      </>}
      {selectedMemory ? <div className="maintenance-revisions">
        <p className="muted">{selectedMemory.name} / status: {selectedMemory.status}</p>
        {selectedMemory.revisions.length === 0 ? <p className="muted">復元可能なrevisionはありません。</p> : <ul>
          {selectedMemory.revisions.map((revision) => <li key={revision.id}>
            <span>{revision.created_at} / {revision.reason_code}</span>
            <button className="secondary" type="button" disabled={pending !== null || selectedMemory.status !== 'archived'} onClick={() => void restoreRevision(revision.id)}>
              {pending === revision.id ? '復元中…' : 'このrevisionから復元'}
            </button>
          </li>)}
        </ul>}
        {selectedMemory.next_revision_after ? <button className="secondary" type="button" disabled={pending !== null} onClick={() => void loadMoreRevisions()}>さらにrevisionを表示</button> : null}
      </div> : null}
      <ul className="maintenance-events" aria-label="棚卸し履歴">
        {events.map((item) => <li key={item.operation_id}><time dateTime={item.created_at}>{item.created_at}</time> / {item.action} / {item.reason_code}</li>)}
      </ul>
      {nextEventAfter ? <button className="secondary" type="button" disabled={pending !== null} onClick={() => void loadMoreEvents()}>過去の履歴を表示</button> : null}
    </section>
    {notice ? <p className="success-message" role="status">{notice}</p> : null}
    {error ? <p className="error-message" role="alert">{error}</p> : null}
  </section>;
}
