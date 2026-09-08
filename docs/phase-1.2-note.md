Phase 1.2 implementation note.

Demo reset is guarded by a local baseline of seeded record IDs. If a record ID exists that was not part of the original demo baseline, the existing reset action refuses to replace the current state. VITE_ENABLE_DEMO_SEED=false disables the guarded reset path. The Google Backup implementation was not modified.