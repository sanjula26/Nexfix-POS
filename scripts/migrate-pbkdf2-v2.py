from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'Expected block not found in {path}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

replace('src/components/AppLayout.tsx', "  const tryUnlock = () => {", "  const tryUnlock = async () => {")
replace('src/components/AppLayout.tsx', "      const res = switchRole('admin', pin);", "      const res = await switchRole('admin', pin);")
replace('src/pages/POS.tsx', "      const ok = verifyAdminPin(gatePin, 'price override');", "      const ok = await verifyAdminPin(gatePin, 'price override');")
replace('src/lib/password.ts', "      salt,", "      salt: salt as unknown as BufferSource,")
