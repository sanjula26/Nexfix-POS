-- The Phone Sales R2 cache was intentionally not enabled because transactional
-- sales remain the source of truth and the current database is small. Keep the
-- schema free of an unused cache-manifest table until a real R2 cache runtime
-- and invalidation contract are deployed together.
drop table if exists public.phone_sales_cache_manifests;
