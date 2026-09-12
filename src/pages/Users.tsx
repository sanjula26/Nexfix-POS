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
  const [confirmPass, setConfirmPass] = useState('');
  const [formErr, setFormErr] = useState('');
  const [formOk, setFormOk] = useState('');

  const save = () => {
    setFormErr('');
    setFormOk('');
    if (!editing || !editing.name.trim() || !editing.email.trim()) {
      setFormErr('Name and email are required');
      return;
    }
    const email = editing.email.trim().toLowerCase();
    if (!email.includes('@')) {
      setFormErr('Enter a valid email (used as login username)');
      return;
    }
    if (state.users.some(u => u.email.toLowerCase() === email && u.id !== editing.id)) {
      setFormErr('This email is already used by another user');
      return;
    }
    const existing = state.users.find(u => u.id === editing.id);
    const newPass = editing.password.trim();
    if (isNew && !newPass) {
      setFormErr('Password is required for new users');
      return;
    }
    if (newPass) {
      if (newPass.length < 4) {
        setFormErr('Password must be at least 4 characters');
        return;
      }
      if (newPass !== confirmPass) {
        setFormErr('Password and confirm password do not match');
        return;
      }
    }
    const toSave = {
      ...editing,
      name: editing.name.trim(),
      email,
      password: newPass || (existing?.password ?? ''),
    };
    if (!toSave.password) {
      setFormErr('Password is required');
      return;
    }
    saveUser(toSave);
    setFormOk(isNew ? 'User created' : 'User updated — name / email / password saved');
    setConfirmPass('');
    setTimeout(() => { setEditing(null); setFormOk(''); }, 600);
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
              setIsNew(true); setConfirmPass(''); setFormErr(''); setFormOk('');
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
                <button className="icon-btn !w-8 !h-8" onClick={() => { setEditing({ ...u, password: '' }); setIsNew(false); setConfirmPass(''); setFormErr(''); setFormOk(''); }}><Pencil size={14} /></button>
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
            <Field label="Email / username (login)">
              <span className="relative block">
                <Mail size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
                <input className="input pl-9" value={editing.email} onChange={e => setEditing({ ...editing, email: e.target.value })} placeholder="name@nexfixsolution.com" />
              </span>
            </Field>
            <Field label={isNew ? 'Password' : 'New password (optional)'} hint={isNew ? 'Stored securely as a password hash' : 'Leave blank to keep current password'}>
              <span className="relative block">
                <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
                <input
                  className="input pl-9"
                  type="password"
                  value={editing.password}
                  onChange={e => { setEditing({ ...editing, password: e.target.value }); setFormErr(''); }}
                  placeholder={isNew ? 'Min 4 characters' : 'Type only if changing password'}
                  autoComplete="new-password"
                />
              </span>
            </Field>
            {(isNew || editing.password.trim().length > 0) && (
              <Field label="Confirm password">
                <input
                  className="input"
                  type="password"
                  value={confirmPass}
                  onChange={e => { setConfirmPass(e.target.value); setFormErr(''); }}
                  placeholder="Repeat password"
                  autoComplete="new-password"
                />
              </Field>
            )}
            {formErr && <p className="text-sm font-medium text-rose-500">{formErr}</p>}
            {formOk && <p className="text-sm font-medium text-emerald-500">{formOk}</p>}
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