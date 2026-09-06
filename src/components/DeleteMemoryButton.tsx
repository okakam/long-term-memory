'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface DeleteMemoryButtonProps {
  projectId: string;
  memoryName: string;
}

export function DeleteMemoryButton({ projectId, memoryName }: DeleteMemoryButtonProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!window.confirm('Delete this memory?')) return;
    setError(null);
    setDeleting(true);
    try {
      const response = await fetch(
        '/api/memories/' + encodeURIComponent(memoryName) + '?project_id=' + encodeURIComponent(projectId),
        { method: 'DELETE' },
      );
      if (!response.ok) {
        setError(await response.text());
        return;
      }
      router.push('/p/' + encodeURIComponent(projectId) + '/memories');
      router.refresh();
    } catch {
      setError('request failed');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <span>
      <button type="button" className="danger" onClick={handleDelete} disabled={deleting}>
        {deleting ? 'Deleting…' : 'Delete'}
      </button>
      {error ? <span className="error-message">{error}</span> : null}
    </span>
  );
}
