from pathlib import Path
p=Path('src/lib/store.tsx')
s=p.read_text()
old="    saveUser, toggleUserActive, deleteUser,"
new="    saveUser, toggleUserActive, deleteUser,"
marker="    saveRepair, updateRepairStatus, deleteRepair,"
if marker not in s:
    raise SystemExit('repair store binding marker not found')
s=s.replace(marker,"    saveRepair, updateRepairStatus, deleteRepair, saveWarrantyClaim,")
p.write_text(s)
