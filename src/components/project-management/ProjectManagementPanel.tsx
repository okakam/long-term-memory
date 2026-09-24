'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';

import { MemberList, type ProjectMember, type ProjectRole } from './MemberList';

export type AccessibleProject = {
  project_id: string;
  role: ProjectRole;
};

type ProjectManagementPanelProps = {
  initialProjects: AccessibleProject[];
  currentUserId: string;
  selectedProjectId?: string;
};

function apiError(response: Response, fallback: string): Promise<never> {
  return response.text().then((text) => { throw new Error(text || fallback); });
}

export function ProjectManagementPanel({ initialProjects, currentUserId, selectedProjectId }: ProjectManagementPanelProps) {
  const router = useRouter();
  const [projects, setProjects] = useState(initialProjects);
  const [selectedId, setSelectedId] = useState(selectedProjectId ?? initialProjects[0]?.project_id ?? '');
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [projectSlug, setProjectSlug] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ProjectRole>('member');
  const [pending, setPending] = useState<'project' | 'member' | string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = projects.find((project) => project.project_id === selectedId);
  const canManage = selectedProject?.role === 'owner';

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void fetch(`/api/projects/${encodeURIComponent(selectedId)}/members`)
      .then((response) => response.ok ? response.json() as Promise<ProjectMember[]> : apiError(response, 'メンバーの取得に失敗しました。'))
      .then((nextMembers) => { if (active) setMembers(nextMembers); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'メンバーの取得に失敗しました。'); });
    return () => { active = false; };
  }, [selectedId]);

  function selectProject(nextId: string) {
    setSelectedId(nextId);
    setError(null);
    router.push(`/dashboard?project=${encodeURIComponent(nextId)}`);
    router.refresh();
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const slug = projectSlug.trim();
    if (!slug) return;
    setPending('project');
    setError(null);
    try {
      const response = await fetch('/api/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug }),
      });
      if (!response.ok) return await apiError(response, 'プロジェクトの作成に失敗しました。');
      const created = await response.json() as { project_id: string };
      setProjects((current) => [...current, { project_id: created.project_id, role: 'owner' }]);
      setProjectSlug('');
      selectProject(created.project_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'プロジェクトの作成に失敗しました。');
    } finally {
      setPending(null);
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId || !email.trim()) return;
    setPending('member');
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(selectedId)}/members`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.trim(), role }),
      });
      if (!response.ok) return await apiError(response, 'メンバーの追加に失敗しました。');
      const created = await response.json() as ProjectMember;
      setMembers((current) => current.some((member) => member.user_id === created.user_id)
        ? current
        : [...current, created]);
      setEmail('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'メンバーの追加に失敗しました。');
    } finally {
      setPending(null);
    }
  }

  async function updateRole(userId: string, nextRole: ProjectRole) {
    if (!selectedId) return;
    setPending(userId);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(selectedId)}/members`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: userId, role: nextRole }),
      });
      if (!response.ok) return await apiError(response, 'ロールの変更に失敗しました。');
      setMembers((current) => current.map((member) => member.user_id === userId ? { ...member, role: nextRole } : member));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ロールの変更に失敗しました。');
    } finally {
      setPending(null);
    }
  }

  async function removeMember(userId: string) {
    if (!selectedId) return;
    setPending(userId);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(selectedId)}/members?user_id=${encodeURIComponent(userId)}`, { method: 'DELETE' });
      if (!response.ok) return await apiError(response, 'メンバーの削除に失敗しました。');
      setMembers((current) => current.filter((member) => member.user_id !== userId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'メンバーの削除に失敗しました。');
    } finally {
      setPending(null);
    }
  }

  return <section className="project-management-panel" aria-labelledby="project-management-heading">
    <div className="section-heading"><div><p className="eyebrow">ACCESS</p><h2 id="project-management-heading">プロジェクト管理</h2></div></div>
    <form className="project-create-form" onSubmit={createProject}>
      <label htmlFor="project-slug">新しいプロジェクト</label>
      <div className="inline-form"><input id="project-slug" value={projectSlug} onChange={(event) => setProjectSlug(event.target.value)} placeholder="project-slug" required />
        <button className="primary" type="submit" disabled={pending !== null}>{pending === 'project' ? '作成中…' : '作成'}</button></div>
    </form>
    {projects.length === 0 ? <p className="muted">プロジェクトを作成すると、Codex MCP接続先として利用できます。</p> : <>
      <label className="project-select-label" htmlFor="managed-project">対象プロジェクト</label>
      <select id="managed-project" value={selectedId} onChange={(event) => selectProject(event.target.value)}>
        {projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.project_id} ({project.role})</option>)}
      </select>
      <section className="member-management" aria-labelledby="member-management-heading">
        <div><h3 id="member-management-heading">メンバー</h3><p className="muted">権限はMCPリクエストごとに確認されます。</p></div>
        {canManage ? <form className="member-add-form" onSubmit={addMember}>
          <label htmlFor="member-email">メールアドレスで追加</label>
          <div className="inline-form"><input id="member-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="member@okakam.net" required />
            <select aria-label="追加するロール" value={role} onChange={(event) => setRole(event.target.value as ProjectRole)}><option value="member">member</option><option value="owner">owner</option></select>
            <button className="primary" type="submit" disabled={pending !== null}>{pending === 'member' ? '追加中…' : '追加'}</button></div>
        </form> : <p className="muted">memberはプロジェクトの閲覧・利用ができます。管理はownerのみ行えます。</p>}
        <MemberList members={members} currentUserId={currentUserId} canManage={canManage} pendingUserId={typeof pending === 'string' && pending !== 'project' && pending !== 'member' ? pending : null} onRoleChange={updateRole} onRemove={removeMember} />
      </section>
    </>}
    {error ? <p className="error-message" role="alert">{error}</p> : null}
  </section>;
}
