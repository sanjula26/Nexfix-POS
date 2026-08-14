import { useMemo, useState } from 'react';
import { ScrollText, Trash2, Activity } from 'lucide-react';
import { usePOS } from '../lib/store';
import { SearchInput, Badge, EmptyState, PageHeading, Avatar, ACTION_TONE } from '../components/ui';
import { timeAgo, fmtDateTime } from '../lib/utils';

export default function AuditLog() {
  const { state } = usePOS();
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('all');
  const [limit, setLimit] = useState(100);

  const actions = useMemo(() => ['all', ...Array.from(new Set(state.audit.map(a => a.action)))], [state.audit]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.audit.filter(a =>
      (action === 'all' || a.action === action) &&
      (!q || a.user.toLowerCase().includes(q) || a.entity.toLowerCase().includes(q) || a.details.toLowerCase().includes(q) || a.action.toLowerCase().includes(q))
    );
  }, [state.audit, search, action]);

  return (
    <div>
      <PageHeading
        chip="Security" chipTone="violet"
        title="Audit Log"
        sub="Track all system activities for security and accountability"
        actions={
          <button className="btn btn-soft opacity-70 cursor-not-allowed" title="Audit log is append-only and cannot be cleared" disabled>
            <Trash2 size={15} /> Protected (append-only)
          </button>
        }
      />

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-line flex flex-wrap items-center gap-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by user, entity, details..." className="flex-1 min-w-[220px]" />
          <select className="input w-44" value={action} onChange={e => setAction(e.target.value)}>
            {actions.map(a => <option key={a} value={a}>{a === 'all' ? 'All actions' : a}</option>)}
          </select>
          <span className="text-xs text-faint num">{rows.length} of {state.audit.length} entries</span>
        </div>

        {rows.length === 0 ? (
          <EmptyState icon={<ScrollText size={26} />} title="No matching entries" sub="System events will appear here" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px]">
              <thead>
                <tr>
                  <th className="th">Time</th><th className="th">User</th><th className="th">Action</th>
                  <th className="th">Entity</th><th className="th">Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map(a => (
                  <tr key={a.id} className="hover:bg-raised/40 transition-colors">
                    <td className="td text-[12px] text-sub whitespace-nowrap" title={fmtDateTime(a.time)}>
                      <span className="flex items-center gap-1.5"><Activity size={11} className="text-faint" />{timeAgo(a.time)}</span>
                    </td>
                    <td className="td">
                      <span className="inline-flex items-center gap-2">
                        <Avatar name={a.user} size={24} />
                        <span className="text-[13px] font-medium text-ink">{a.user}</span>
                      </span>
                    </td>
                    <td className="td"><Badge tone={ACTION_TONE[a.action] || 'slate'}>{a.action}</Badge></td>
                    <td className="td text-[13px] font-semibold text-ink">{a.entity}</td>
                    <td className="td text-[13px] text-sub">{a.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > limit ? (
              <div className="p-4 text-center">
                <button type="button" className="btn btn-soft" onClick={() => setLimit(l => l + 100)}>
                  Load more ({limit} of {rows.length})
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

    </div>
  );
}
