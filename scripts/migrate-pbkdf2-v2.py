from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'Expected block not found in {path}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

replace('src/components/AppLayout.tsx', "    setBusy(true); setError('');\n    setTimeout(() => {", "    setBusy(true); setError('');\n    setTimeout(async () => {")
replace('src/pages/POS.tsx', "    setGateBusy(true); setGateErr('');\n    setTimeout(() => {", "    setGateBusy(true); setGateErr('');\n    setTimeout(async () => {")
replace('src/lib/password.ts', "    new TextEncoder().encode(password),", "    new TextEncoder().encode(password) as unknown as BufferSource,")
replace('src/lib/password.ts', "      salt,", "      salt: salt as unknown as BufferSource,")
