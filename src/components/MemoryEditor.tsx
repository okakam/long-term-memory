'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';

import { DeleteMemoryButton } from '@/components/DeleteMemoryButton';
import type { Memory } from '@/lib/memory/types';

interface MemoryEditorProps {
  memory: Memory;
  projectId: string;
  readOnly?: boolean;
}

export function MemoryEditor({ memory, projectId, readOnly = false }: MemoryEditorProps) {
  if (readOnly) return <p>shared scope is read-only</p>;
  return <EditableMemoryForm memory={memory} projectId={projectId} />;
}

function EditableMemoryForm({ memory, projectId }: Omit<MemoryEditorProps, 'readOnly'>) {
  const router = useRouter();
  const [description, setDescription] = useState(memory.description);
  const [tags, setTags] = useState(memory.tags.join(', '));
  const [links, setLinks] = useState(memory.links.join(', '));
  const [body, setBody] = useState(memory.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        '/api/memories/' + encodeURIComponent(memory.name) + '?project_id=' + encodeURIComponent(projectId),
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            description: description.trim(),
            body,
            tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
            links: links.split(',').map((link) => link.trim()).filter(Boolean),
          }),
        },
      );
      if (!response.ok) {
        setError(await response.text());
        return;
      }
      router.push('/p/' + encodeURIComponent(projectId) + '/memories/' + encodeURIComponent(memory.name));
      router.refresh();
    } catch {
      setError('request failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="editor-grid" onSubmit={handleSubmit}>
      <section className="editor-form">
        <label>
          Description
          <input value={description} onChange={(event) => setDescription(event.target.value)} required />
        </label>
        <label>
          Tags
          <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="comma-separated tags" />
        </label>
        <label>
          Links
          <input value={links} onChange={(event) => setLinks(event.target.value)} placeholder="comma-separated memory names" />
        </label>
        <label>
          Body
          <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={20} />
        </label>
        {error ? <p className="error-message">{error}</p> : null}
        <div className="actions">
          <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          <DeleteMemoryButton projectId={projectId} memoryName={memory.name} />
          <button type="button" onClick={() => router.back()}>Cancel</button>
        </div>
      </section>
      <section className="markdown-preview">
        <h2>Preview</h2>
        <ReactMarkdown>{body}</ReactMarkdown>
      </section>
    </form>
  );
}

export default MemoryEditor;
