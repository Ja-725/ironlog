-- ============================================================================
-- IronLog — Supabase 資料表與 Row Level Security (RLS) 初始化腳本
-- 請複製以下全部內容，貼上至 Supabase 後台 -> SQL Editor 並點擊 Run 執行
-- ============================================================================

-- 1. 建立 workout_logs 資料表
create table if not exists public.workout_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  date text not null,
  exercise text not null,
  weight numeric not null check (weight >= 0),
  reps integer not null check (reps >= 1),
  rpe numeric null check (rpe is null or (rpe >= 1 and rpe <= 10)),
  created_at timestamptz not null default now()
);

-- 建立常用查詢索引（加速依使用者與日期排序查詢）
create index if not exists idx_workout_logs_user_date
  on public.workout_logs (user_id, date desc, created_at asc);

-- 2. 啟用 Row Level Security (RLS)
alter table public.workout_logs enable row level security;

-- 3. 建立 RLS 安全性策略（確保每位已登入使用者僅能存取自己的紀錄）

-- [SELECT] 僅允許查詢自己的訓練紀錄
drop policy if exists "Users can view own workout_logs" on public.workout_logs;
create policy "Users can view own workout_logs"
  on public.workout_logs
  for select
  to authenticated
  using (auth.uid() = user_id);

-- [INSERT] 僅允許新增屬於自己 user_id 的訓練紀錄
drop policy if exists "Users can insert own workout_logs" on public.workout_logs;
create policy "Users can insert own workout_logs"
  on public.workout_logs
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- [UPDATE] 僅允許修改屬於自己 user_id 的訓練紀錄
drop policy if exists "Users can update own workout_logs" on public.workout_logs;
create policy "Users can update own workout_logs"
  on public.workout_logs
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- [DELETE] 僅允許刪除屬於自己 user_id 的訓練紀錄
drop policy if exists "Users can delete own workout_logs" on public.workout_logs;
create policy "Users can delete own workout_logs"
  on public.workout_logs
  for delete
  to authenticated
  using (auth.uid() = user_id);
