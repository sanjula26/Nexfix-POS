import { Fragment } from 'react';
import { ShieldCheck, UserRound, Briefcase, Wrench } from 'lucide-react';
import { usePOS } from '../lib/store';
import { PERMISSION_KEYS } from '../lib/seed';
import { Toggle, Badge, PageHeading } from '../components/ui';

export default function Permissions() {
  const { state, setPermission } = usePOS();
  const groups = ['Pages', 'Actions'];

  return (
    <div>
      <PageHeading
        chip="Access Control" chipTone="violet"
        title="Permissions"
        sub="Toggle what each role can see and do — changes apply instantly"
      />

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr>
                <th className="th">Capability</th>
                <th className="th !text-center w-40">
                  <span className="inline-flex items-center gap-1.5"><ShieldCheck size={13} className="text-violet-500" /> ADMIN</span>
                </th>
                <th className="th !text-center w-40">
                  <span className="inline-flex items-center gap-1.5"><UserRound size={13} className="text-emerald-500" /> CASHIER</span>
                </th>
                <th className="th !text-center w-40">
                  <span className="inline-flex items-center gap-1.5"><Briefcase size={13} className="text-sky-500" /> MANAGER</span>
                </th>
                <th className="th !text-center w-40">
                  <span className="inline-flex items-center gap-1.5"><Wrench size={13} className="text-amber-500" /> TECHNICIAN</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <Fragment key={g}>
                  <tr>
                    <td colSpan={5} className="td !py-2.5 bg-raised/50">
                      <span className="text-[11px] font-extrabold tracking-[0.14em] uppercase text-faint">{g}</span>
                    </td>
                  </tr>
                  {PERMISSION_KEYS.filter(k => k.group === g).map(k => (
                    <tr key={k.key} className="hover:bg-raised/40 transition-colors">
                      <td className="td font-medium text-[13.5px]">{k.label}</td>
                      <td className="td text-center">
                        <div className="flex justify-center">
                          <Toggle checked={true} onChange={() => {}} disabled />
                        </div>
                      </td>
                      <td className="td text-center">
                        <div className="flex justify-center">
                          <Toggle
                            checked={!!state.permissions.cashier[k.key]}
                            onChange={v => setPermission('cashier', k.key, v)}
                          />
                        </div>
                      </td>
                      <td className="td text-center">
                        <div className="flex justify-center">
                          <Toggle checked={!!state.permissions.manager?.[k.key]} onChange={v => setPermission('manager', k.key, v)} />
                        </div>
                      </td>
                      <td className="td text-center">
                        <div className="flex justify-center">
                          <Toggle checked={!!state.permissions.technician?.[k.key]} onChange={v => setPermission('technician', k.key, v)} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-6 py-4 border-t border-line flex flex-wrap items-center gap-2.5 text-[12px] text-faint">
          <Badge tone="violet"><ShieldCheck size={11} /> ADMIN has full access</Badge>
          <span>Hidden pages disappear from the cashier sidebar immediately. Switch roles from the sidebar to preview.</span>
        </div>
      </div>
    </div>
  );
}
