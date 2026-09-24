'use client';

export type ProjectRole = 'owner' | 'member';

export type ProjectMember = {
  user_id: string;
  email: string | null;
  role: ProjectRole;
};

type MemberListProps = {
  members: ProjectMember[];
  currentUserId: string;
  canManage: boolean;
  pendingUserId: string | null;
  onRoleChange: (userId: string, role: ProjectRole) => void;
  onRemove: (userId: string) => void;
};

export function MemberList({ members, currentUserId, canManage, pendingUserId, onRoleChange, onRemove }: MemberListProps) {
  if (members.length === 0) return <p className="muted">メンバーを読み込んでいます…</p>;

  return <div className="member-table-wrap">
    <table className="member-table">
      <thead><tr><th>メールアドレス</th><th>ロール</th><th>操作</th></tr></thead>
      <tbody>{members.map((member) => {
        const selfOwner = member.user_id === currentUserId && member.role === 'owner';
        const pending = pendingUserId === member.user_id;
        return <tr key={member.user_id}>
          <td>
            <strong>{member.email ?? member.user_id}</strong>
            {member.email ? <span className="member-uid">{member.user_id}</span> : null}
          </td>
          <td>{canManage ? <select
            aria-label={`${member.email ?? member.user_id} のロール`}
            title={selfOwner ? '自分自身のownerロールはこの画面から変更できません' : undefined}
            value={member.role}
            disabled={pending || selfOwner}
            onChange={(event) => onRoleChange(member.user_id, event.target.value as ProjectRole)}
          ><option value="owner">owner</option><option value="member">member</option></select> : <span className="role-badge">{member.role}</span>}</td>
          <td>{canManage && !selfOwner ? <button className="danger" type="button" disabled={pending} onClick={() => onRemove(member.user_id)}>
            {pending ? '処理中…' : '削除'}
          </button> : <span className="muted">—</span>}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}
