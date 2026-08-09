-- ============================================================================
-- FinModel Lab 账号系统 —— 数据库初始化
--
-- 用法：Supabase 后台 → SQL Editor → New query → 整份粘进去 → Run。
-- 可以重复执行，不会报错也不会覆盖已有数据。
--
-- 这里最重要的是行级安全策略（RLS）：
-- 权限是**数据库强制的**，不是前端判断的。哪怕有人改前端代码、
-- 直接拿 anon key 调接口，也只能读到自己那一行。
-- ============================================================================

-- ---------------------------------------------------------------- 表

create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  nickname   text not null,
  email      text,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);
comment on table public.profiles is '学员资料。只收邮箱和昵称。';

create table if not exists public.progress (
  user_id          uuid primary key references auth.users on delete cascade,
  state            jsonb not null default '{}'::jsonb,   -- 整份进度，就是本地那个 JSON
  models_started   int not null default 0,               -- 下面几列是冗余的汇总，
  models_completed int not null default 0,               -- 为了班级看板不用解析 JSON
  correct_cells    int not null default 0,
  total_seconds    int not null default 0,
  updated_at       timestamptz not null default now()
);
comment on table public.progress is '学习进度。state 是整份 JSON，其余列是为看板做的冗余汇总。';

-- ---------------------------------------------------------------- 管理员判定
-- 单独做成函数并加 security definer，是为了避免 profiles 的策略递归引用自己。

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------- 注册时自动建行

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, nickname, email)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'nickname'), ''), split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;

  insert into public.progress (user_id) values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- 行级安全

alter table public.profiles enable row level security;
alter table public.progress enable row level security;

-- profiles：本人可读可改；管理员可读全部
drop policy if exists "本人可读自己的资料" on public.profiles;
create policy "本人可读自己的资料" on public.profiles
  for select using (id = auth.uid() or public.is_admin());

drop policy if exists "本人可改自己的资料" on public.profiles;
create policy "本人可改自己的资料" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "本人可建自己的资料" on public.profiles;
create policy "本人可建自己的资料" on public.profiles
  for insert with check (id = auth.uid());

-- progress：本人可读可写；管理员可读全部（管理员不能改别人的进度）
drop policy if exists "本人可读自己的进度" on public.progress;
create policy "本人可读自己的进度" on public.progress
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists "本人可建自己的进度" on public.progress;
create policy "本人可建自己的进度" on public.progress
  for insert with check (user_id = auth.uid());

drop policy if exists "本人可改自己的进度" on public.progress;
create policy "本人可改自己的进度" on public.progress
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------- 索引
create index if not exists progress_updated_at_idx on public.progress (updated_at desc);

-- ============================================================================
-- 装完之后还要做两件事
--
-- 1) 把你自己设成管理员。先用网站注册一个账号，然后回来执行（换成你的邮箱）：
--
--      update public.profiles set is_admin = true
--      where email = '你的邮箱@example.com';
--
--    设完刷新网站，侧栏才会出现「班级看板」。
--
-- 2) 决定要不要开邮箱验证。
--    Authentication → Providers → Email → Confirm email
--      开着（默认）：注册后必须点验证邮件才能登录。更规范，但免费版
--                    自带的邮件服务有频率限制，人多时要接自己的 SMTP。
--      关掉：      注册完直接就能用。适合小范围试。
--
-- 想看谁注册了：Authentication → Users，有邮箱、注册时间、最后登录时间。
-- 想看谁练到哪：用网站里的「班级看板」页面。
-- ============================================================================
