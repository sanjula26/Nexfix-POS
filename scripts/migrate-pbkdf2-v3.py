from pathlib import Path
import re


def replace(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'Expected block not found in {path}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

p = Path('src/pages/POS.tsx')
t = p.read_text(encoding='utf-8')
t = re.sub(r"const ok =\s*(?:await\s+)?verifyAdminPin\(gatePin, 'price override'\);", "const ok = await verifyAdminPin(gatePin, 'price override');", t, count=1)
t = t.replace("    setGateBusy(true); setGateErr('');\n    setTimeout(() => {", "    setGateBusy(true); setGateErr('');\n    setTimeout(async () => {", 1)
p.write_text(t, encoding='utf-8')

replace('src/lib/passwordAuth.ts', "import { hashPassword as hashPbkdf2Password, isPbkdf2Hash, verifyPassword as verifyPbkdf2Password } from './password';", "import { hashPassword as hashPbkdf2Password, isPbkdf2Hash, verifyPassword as verifyPbkdf2Password } from './password';\n\nexport { isPbkdf2Hash } from './password';")
