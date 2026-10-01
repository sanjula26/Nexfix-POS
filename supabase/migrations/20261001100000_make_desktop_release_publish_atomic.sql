-- Keep the private Windows updater on exactly one active release per platform/channel.
-- Publishing is done through one transaction so a failed insert never leaves the
-- updater with zero active releases or two active releases.

create unique index if not exists desktop_releases_one_active_per_platform_channel
  on public.desktop_releases (platform, channel)
  where is_active = true;

create or replace function public.publish_desktop_release(
  p_version text,
  p_channel text,
  p_platform text,
  p_installer_path text,
  p_installer_name text,
  p_installer_sha512 text,
  p_installer_size bigint,
  p_release_notes text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(trim(p_version), '') = ''
     or coalesce(trim(p_channel), '') = ''
     or coalesce(trim(p_platform), '') = ''
     or coalesce(trim(p_installer_path), '') = ''
     or coalesce(trim(p_installer_name), '') = ''
     or coalesce(trim(p_installer_sha512), '') = ''
     or p_installer_size <= 0 then
    raise exception 'Invalid desktop release metadata';
  end if;

  -- Both statements are part of the same transaction. If the insert fails,
  -- PostgreSQL rolls the update back and the previous active release remains.
  update public.desktop_releases
     set is_active = false
   where platform = p_platform
     and channel = p_channel
     and is_active = true
     and version <> p_version;

  insert into public.desktop_releases (
    version,
    channel,
    platform,
    installer_path,
    installer_name,
    installer_sha512,
    installer_size,
    portable_path,
    portable_name,
    release_notes,
    is_active
  )
  values (
    p_version,
    p_channel,
    p_platform,
    p_installer_path,
    p_installer_name,
    p_installer_sha512,
    p_installer_size,
    null,
    null,
    p_release_notes,
    true
  )
  on conflict (version) do update
     set channel = excluded.channel,
         platform = excluded.platform,
         installer_path = excluded.installer_path,
         installer_name = excluded.installer_name,
         installer_sha512 = excluded.installer_sha512,
         installer_size = excluded.installer_size,
         portable_path = null,
         portable_name = null,
         release_notes = excluded.release_notes,
         is_active = true,
         published_at = now();
end;
$$;

revoke all on function public.publish_desktop_release(
  text, text, text, text, text, text, bigint, text
) from public, anon, authenticated;

grant execute on function public.publish_desktop_release(
  text, text, text, text, text, text, bigint, text
) to service_role;
