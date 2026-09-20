alter table public.customers
  add column if not exists credit_limit numeric(12,2) not null default 0;

update public.customers
   set credit_limit = greatest(coalesce(credit_limit, 0), 0)
 where credit_limit is null or credit_limit < 0;
