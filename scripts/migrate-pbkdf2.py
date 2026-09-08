from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'Expected block not found in {path}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


replace('src/lib/store.tsx',
    "import { dkey, uid, POINT_VALUE, pointsForRs, hashPin, hashPassword, verifyPassword, isHashed } from './utils';",
    "import { dkey, uid, POINT_VALUE, pointsForRs, hashPin, hashPassword, isHashed } from './utils';\nimport { hashCredential, isPbkdf2Hash, verifyCredential } from './passwordAuth';")
replace('src/lib/store.tsx', "signIn: (email: string, password: string, remember: boolean) => { ok: boolean; error?: string };", "signIn: (email: string, password: string, remember: boolean) => Promise<{ ok: boolean; error?: string }>;")
replace('src/lib/store.tsx', "switchRole: (role: Role, pin?: string) => { ok: boolean; error?: string };", "switchRole: (role: Role, pin?: string) => Promise<{ ok: boolean; error?: string }>;")
replace('src/lib/store.tsx', "changeAdminPin: (current: string, next: string) => { ok: boolean; error?: string };", "changeAdminPin: (current: string, next: string) => Promise<{ ok: boolean; error?: string }>;")
replace('src/lib/store.tsx', "verifyAdminPin: (pin: string, reason?: string) => boolean;", "verifyAdminPin: (pin: string, reason?: string) => Promise<boolean>;")
replace('src/lib/store.tsx', """  const users = (s.users || []).map(u => ({
    ...u,
    password: isHashed(u.password) ? u.password : hashPassword(u.password || ''),
  }));""", """  // Credentials are migrated lazily after successful verification.
  const users = (s.users || []).map(u => ({ ...u, password: u.password || '' }));""")
replace('src/lib/store.tsx', """  const verifyAdminPin = useCallback((pin: string, reason?: string): boolean => {
    const ok = verifyPassword(pin || '', state.settings.adminPinHash);""", """  const verifyAdminPin = useCallback(async (pin: string, reason?: string): Promise<boolean> => {
    const verification = await verifyCredential(pin || '', state.settings.adminPinHash);
    const ok = verification.ok;
    if (ok && verification.needsRehash) {
      const upgraded = await hashCredential(pin || '');
      setState(s => ({ ...s, settings: { ...s.settings, adminPinHash: upgraded } }));
    }""")
replace('src/lib/store.tsx', """  const signIn = useCallback((email: string, password: string, remember: boolean) => {
    const u = state.users.find(x => x.email.toLowerCase() === email.trim().toLowerCase());
    if (!u) return { ok: false, error: 'No account found for this email' };
    // Support both hashed (new) and legacy plaintext during transition
    const passwordOk = isHashed(u.password)
      ? verifyPassword(password, u.password)
      : u.password === password;
    if (!passwordOk) return { ok: false, error: 'Incorrect password' };""", """  const signIn = useCallback(async (email: string, password: string, remember: boolean) => {
    const u = state.users.find(x => x.email.toLowerCase() === email.trim().toLowerCase());
    if (!u) return { ok: false, error: 'No account found for this email' };
    const verification = await verifyCredential(password, u.password);
    if (!verification.ok) return { ok: false, error: 'Incorrect password' };""")
replace('src/lib/store.tsx', """    // Auto-upgrade plaintext password to hash on successful login
    if (!isHashed(u.password)) {
      setState(s => ({
        ...s,
        users: s.users.map(x => x.id === u.id ? { ...x, password: hashPassword(password) } : x),
        audit: [{ id: uid(), time: new Date().toISOString(), user: u.email, action: 'LOGIN', entity: 'Auth', details: `${u.name} signed in` }, ...s.audit].slice(0, 500),
      }));
    } else {
      setState(s => ({
        ...s,
        audit: [{ id: uid(), time: new Date().toISOString(), user: u.email, action: 'LOGIN', entity: 'Auth', details: `${u.name} signed in` }, ...s.audit].slice(0, 500),
      }));
    }
    return { ok: true };""", """    const upgradedPassword = verification.needsRehash ? await hashCredential(password) : u.password;
    setState(s => ({
      ...s,
      users: s.users.map(x => x.id === u.id ? { ...x, password: upgradedPassword } : x),
      audit: [{ id: uid(), time: new Date().toISOString(), user: u.email, action: 'LOGIN', entity: 'Auth', details: `${u.name} signed in` }, ...s.audit].slice(0, 500),
    }));
    return { ok: true };""")
replace('src/lib/store.tsx', "const switchRole = useCallback((role: Role, pin?: string): { ok: boolean; error?: string } => {", "const switchRole = useCallback(async (role: Role, pin?: string): Promise<{ ok: boolean; error?: string }> => {")
replace('src/lib/store.tsx', """    if (role === 'admin' && user?.role === 'cashier') {
      if (!verifyPassword(pin || '', state.settings.adminPinHash)) {""", """    if (role === 'admin' && user?.role === 'cashier') {
      const verification = await verifyCredential(pin || '', state.settings.adminPinHash);
      if (!verification.ok) {""")
replace('src/lib/store.tsx', """        return { ok: false, error: 'Incorrect admin password' };
      }
      // Remember current cashier""", """        return { ok: false, error: 'Incorrect admin password' };
      }
      if (verification.needsRehash) {
        const upgraded = await hashCredential(pin || '');
        setState(s => ({ ...s, settings: { ...s.settings, adminPinHash: upgraded } }));
      }
      // Remember current cashier""")
replace('src/lib/store.tsx', """  const changeAdminPin = useCallback((current: string, next: string): { ok: boolean; error?: string } => {
    if (user?.role !== 'admin') return { ok: false, error: 'Only admins can change this password' };
    if (!verifyPassword(current, state.settings.adminPinHash)) return { ok: false, error: 'Current password is incorrect' };
    if (next.trim().length < 4) return { ok: false, error: 'New password must be at least 4 characters' };
    setState(s => ({ ...s, settings: { ...s.settings, adminPinHash: hashPin(next.trim()) } }));
    pushAudit('SETTINGS', 'Security', 'Admin switch password changed');
    return { ok: true };
  }, [user, state.settings.adminPinHash, pushAudit]);""", """  const changeAdminPin = useCallback(async (current: string, next: string): Promise<{ ok: boolean; error?: string }> => {
    if (user?.role !== 'admin') return { ok: false, error: 'Only admins can change this password' };
    const verification = await verifyCredential(current, state.settings.adminPinHash);
    if (!verification.ok) return { ok: false, error: 'Current password is incorrect' };
    if (next.trim().length < 4) return { ok: false, error: 'New password must be at least 4 characters' };
    const upgraded = await hashCredential(next.trim());
    setState(s => ({ ...s, settings: { ...s.settings, adminPinHash: upgraded } }));
    pushAudit('SETTINGS', 'Security', 'Admin switch password changed');
    return { ok: true };
  }, [user, state.settings.adminPinHash, pushAudit]);""")
replace('src/lib/store.tsx', """  const saveUser = useCallback((u: AppUser) => {
    const exists = state.users.some(x => x.id === u.id);
    // Always store password as hash (skip re-hash if already hashed and unchanged)
    const existing = state.users.find(x => x.id === u.id);
    const password = isHashed(u.password)
      ? u.password
      : (existing && u.password === existing.password ? existing.password : hashPassword(u.password));
    const toSave = { ...u, password };""", """  const saveUser = useCallback(async (u: AppUser) => {
    const exists = state.users.some(x => x.id === u.id);
    const existing = state.users.find(x => x.id === u.id);
    const password = existing && u.password === existing.password
      ? existing.password
      : (isPbkdf2Hash(u.password) ? u.password : await hashCredential(u.password));
    const toSave = { ...u, password };""")

replace('src/pages/Login.tsx', "    const res = signIn(email, password, remember);", "    const res = await signIn(email, password, remember);")
replace('src/pages/Settings.tsx', "  const submitPin = () => {", "  const submitPin = async () => {")
replace('src/pages/Settings.tsx', "  const res = changeAdminPin(pinCur, pinNew);", "  const res = await changeAdminPin(pinCur, pinNew);")
replace('src/components/AppLayout.tsx', "  const tryUnlock = () => {", "  const tryUnlock = async () => {")
replace('src/components/AppLayout.tsx', "      const res = switchRole('admin', pin);", "      const res = await switchRole('admin', pin);")
replace('src/pages/Users.tsx', "  const save = () => {", "  const save = async () => {")
replace('src/pages/Users.tsx', "    saveUser(toSave);", "    await saveUser(toSave);")
replace('src/pages/Users.tsx', "hint={isNew ? 'Stored as SHA-256 hash' : 'Leave blank to keep current password'}", "hint={isNew ? 'Stored as PBKDF2-SHA256 hash' : 'Leave blank to keep current password'}")
