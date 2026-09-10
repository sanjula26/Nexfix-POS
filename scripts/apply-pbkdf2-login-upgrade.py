from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
store = ROOT / 'src/lib/store.tsx'
login = ROOT / 'src/pages/Login.tsx'

s = store.read_text(encoding='utf-8')
original = s

old_import = "import { dkey, uid, POINT_VALUE, pointsForRs, hashPin, hashPassword, verifyPassword, isHashed } from './utils';"
new_import = "import { dkey, uid, POINT_VALUE, pointsForRs, hashPin, hashPassword, verifyPassword, isHashed, isPasswordHash } from './utils';\nimport { hashPasswordAsync, verifyPasswordAsync } from './passwordAsync';"
if old_import not in s:
    raise SystemExit('Expected store utils import was not found')
s = s.replace(old_import, new_import, 1)

old_type = "signIn: (email: string, password: string, remember: boolean) => { ok: boolean; error?: string };"
new_type = "signIn: (email: string, password: string, remember: boolean) => Promise<{ ok: boolean; error?: string }>;"
if old_type not in s:
    raise SystemExit('Expected StoreCtx signIn type was not found')
s = s.replace(old_type, new_type, 1)

old_signin = r'''  const signIn = useCallback((email: string, password: string, remember: boolean) => {
    const u = state.users.find(x => x.email.toLowerCase() === email.trim().toLowerCase());
    if (!u) return { ok: false, error: 'No account found for this email' };
    // Support both hashed (new) and legacy plaintext during transition
    const passwordOk = isHashed(u.password)
      ? verifyPassword(password, u.password)
      : u.password === password;
    if (!passwordOk) return { ok: false, error: 'Incorrect password' };
    if (!u.active) return { ok: false, error: 'This account has been deactivated' };
    const sess = { userId: u.id, remember };
    setSession(sess);
    try {
      if (remember) localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
      else sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    } catch { /* ignore */ }
    // Auto-upgrade plaintext password to hash on successful login
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
    return { ok: true };
  }, [state.users]);'''
new_signin = r'''  const signIn = useCallback(async (email: string, password: string, remember: boolean) => {
    const u = state.users.find(x => x.email.toLowerCase() === email.trim().toLowerCase());
    if (!u) return { ok: false, error: 'No account found for this email' };

    // Verify both current PBKDF2 hashes and legacy SHA-256 hashes. Plaintext
    // passwords are retained only for the one-time migration path.
    const passwordOk = isHashed(u.password)
      ? await verifyPasswordAsync(password, u.password)
      : u.password === password;
    if (!passwordOk) return { ok: false, error: 'Incorrect password' };
    if (!u.active) return { ok: false, error: 'This account has been deactivated' };

    const sess = { userId: u.id, remember };
    setSession(sess);
    try {
      if (remember) localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
      else sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    } catch { /* ignore */ }

    // Successful login upgrades both legacy SHA-256 and plaintext passwords
    // to a fresh random-salt PBKDF2-SHA-256 hash. Current PBKDF2 hashes are
    // left unchanged so repeated logins do not cause unnecessary rehashing.
    const needsUpgrade = !isPasswordHash(u.password);
    const upgradedPassword = needsUpgrade ? await hashPasswordAsync(password) : u.password;
    setState(s => ({
      ...s,
      users: needsUpgrade
        ? s.users.map(x => x.id === u.id ? { ...x, password: upgradedPassword } : x)
        : s.users,
      audit: [{
        id: uid(), time: new Date().toISOString(), user: u.email, action: 'LOGIN', entity: 'Auth',
        details: `${u.name} signed in${needsUpgrade ? ' · password upgraded to PBKDF2' : ''}`,
      }, ...s.audit].slice(0, 500),
    }));
    return { ok: true };
  }, [state.users]);'''
if old_signin not in s:
    raise SystemExit('Expected signIn implementation was not found')
s = s.replace(old_signin, new_signin, 1)

if s == original:
    raise SystemExit('Store patch made no changes')
store.write_text(s, encoding='utf-8')

l = login.read_text(encoding='utf-8')
old_call = "const res = signIn(email, password, remember);"
new_call = "const res = await signIn(email, password, remember);"
if old_call not in l:
    raise SystemExit('Expected Login signIn call was not found')
l = l.replace(old_call, new_call, 1)
login.write_text(l, encoding='utf-8')
print('PBKDF2 login upgrade patch applied successfully')
