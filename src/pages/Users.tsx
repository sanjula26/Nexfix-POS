import { useState } from 'react';
import { Plus, Pencil, Trash2, ShieldCheck, UserRound, UserCog, Mail, Lock } from 'lucide-react';
import { usePOS } from '../lib/store';
import { Badge, Modal, Field, Avatar, PageHeading } from '../components/ui';
import { fmtDate, uid } from '../lib/utils';
import { Toggle } from '../components/ui';
import type { AppUser, Role } from '../lib/types';

export default function Users() {
  const { state, saveUser, toggleUserActive, deleteUser, user } = usePOS();
  const [editing, setEditing] = useState<AppUser | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [deleting, setDeleting] = useState<AppUser | null>(null);

  const save = () => {
    if (!editing || !editing.name.trim() || !editing.email.trim()) return;
    // New users must have a password; existing users can leave blank to keep current hash
    if (isNew && !editing.password.trim()) return;
    if (state.users.some(u => u.email.toLowerCase() === editing.email.toLowerCase() && u.id !== editing.id)) return;
    const existing = state.users.find(u => u.id === editing.id);
    const toSave = {
      ...editing,
      password: editing.password.trim() || (existing?.password ?? ''),
    };
    if (!toSave.password) return;
    saveUser(toSave);
    setEditing(null);
  };

  return (
    <div>
      <PageHeading
        chip="Team" chipTone="violet"
        title="Users"
        sub={`${state.users.length} staff accounts · roles control page access`}
        actions={
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditing({ id: uid(), name: '', email: '', password: '', role: 'cashier', active: true, createdAt: new Date().toISOString() });
              setIsNew(true);
            }}
          >
            <Plus size={15} /> Add User
          </button>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {state.users.map(u => (
          <div key={u.id} className={`card p-5 transition-opacity ${u.active ? '' : 'opacity-60'}`}>
            <div className="flex items-start gap-3.5">
              <Avatar name={u.name} size={44} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-ink">{u.name}</span>
                  {u.id === user?.id && <Badge tone="blue">YOU</Badge>}
                </div>
                <div className="text-[12px] text-faint truncate mt-0.5">{u.email}</div>
              </div>
              <Badge tone={u.role === 'admin' ? 'violet' : 'emerald'}>
                {u.role === 'admin' ? <ShieldCheck size={11} /> : <UserRound size={11} />}
                {u.role.toUpperCase()}
              </Badge>
            </div>
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-line">
              <div>
                <span className="text-[10px] font-bold tracking-wider uppercase text-faint">Since {fmtDate(u.createdAt)}</span>
                <div className={`text-[11px] font-bold mt-0.5 ${u.active ? 'text-emerald-500' : 'text-rose-500'}`}>
                  {u.active ? 'ACTIVE' : 'DEACTIVATED'}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Toggle checked={u.active} onChange={() => toggleUserActive(u.id)} disabled={u.id === user?.id} />
                <button className="icon-btn !w-8 !h-8" onClick={() => { setEditing({ ...u, password: '' }); setIsNew(false); }}><Pencil size={14} /></button>
                {u.id !== user?.id && (
                  <button className="icon-btn !w-8 !h-8 hover:!bg-rose-500/10 hover:!text-rose-500" onClick={() => setDeleting(u)}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={isNew ? 'Add user' : 'Edit user'} sub={editing?.email}>
        {editing && (
          <div className="space-y-4">
            <Field label="Full name">
              <span className="relative block">
                <UserCog size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
                <input className="input pl-9" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="Cashier name" />
              </span>
            </Field>
            <Field label="Email (login)">
              <span className="relative block">
                <Mail size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
                <input className="input pl-9" value={editing.email} onChange={e => setEditing({ ...editing, email: e.target.value })} placeholder="name@nexfixsolution.com" />
              </span>
            </Field>
            <Field label="Password" hint={isNew ? 'Will be stored hashed (SHA-256)' : 'Leave unchanged or type a new password — always stored hashed'}>
              <span className="relative block">
                <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
                <input
                  className="input pl-9"
                  type="password"
                  value={editing.password}
                  onChange={e => setEditing({ ...editing, password: e.target.value })}
                  placeholder={isNew ? '••••••••' : 'Type new password to change'}
                  autoComplete="new-password"
                />
              </span>
            </Field>
            <Field label="Role">
              <div className="grid grid-cols-2 gap-2">
                {(['admin', 'cashier'] as Role[]).map(r => (
                  <button
                    key={r}
                    className={`btn ${editing.role === r ? (r === 'admin' ? 'btn-primary' : 'btn-emerald') : 'btn-soft'}`}
                    onClick={() => setEditing({ ...editing, role: r })}
                  >
                    {r === 'admin' ? <ShieldCheck size={14} /> : <UserRound size={14} />}
                    {r === 'admin' ? 'Administrator' : 'Cashier'}
                  </button>
                ))}
              </div>
            </Field>
            <div className="flex gap-2.5 pt-1">
              <button
                className="btn btn-primary flex-1"
                onClick={save}
                disabled={!editing.name.trim() || !editing.email.trim() || (isNew && !editing.password.trim())}
              >
                {isNew ? 'Create account' : 'Save changes'}
              </button>
              <button className="btn btn-soft" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete user?" sub={deleting?.name}>
        <p className="text-sm text-sub"><b className="text-ink">{deleting?.name}</b> will lose access immediately. Their sales history stays in records.</p>
        <div className="flex gap-2.5 mt-5">
          <button className="btn btn-danger-soft flex-1" onClick={() => { if (deleting) deleteUser(deleting.id); setDeleting(null); }}>
            <Trash2 size={15} /> Delete
          </button>
          <button className="btn btn-soft flex-1" onClick={() => setDeleting(null)}>Cancel</button>
        </div>
      </Modal>
    </div>
  );
}
