-- ============================================================
--  WaBot — Full schema reset
--  Run this in the Supabase SQL Editor (Dashboard → SQL Editor)
--  WARNING: Drops ALL existing WaBot tables and recreates them
-- ============================================================

-- ── 1. Drop everything (cascade removes dependent objects) ────
drop table if exists bot_activity  cascade;
drop table if exists bots          cascade;
drop table if exists subscriptions cascade;
drop table if exists users         cascade;

drop function if exists update_updated_at() cascade;

-- ── 2. Extensions ─────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ── 3. Shared trigger: keep updated_at current ────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── 4. users ──────────────────────────────────────────────────
create table users (
  id                 uuid        primary key default gen_random_uuid(),
  email              text        not null unique,
  password_hash      text        not null,
  full_name          text,
  email_verified     boolean     not null default false,
  verification_token text        unique,
  plan_tier          text        not null default 'free'
                                 check (plan_tier in ('free', 'paid')),
  -- stores API key metadata as: { "apiKeys": [{id, name, prefix, keyHash, createdAt}] }
  settings           jsonb       not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger users_updated_at
  before update on users
  for each row execute function update_updated_at();

create index users_email_idx              on users(email);
create index users_verification_token_idx on users(verification_token)
  where verification_token is not null;

-- RLS: service role key (used by our backend) bypasses RLS.
-- Anon/public key has zero access — all reads go through our Express API.
alter table users enable row level security;

-- ── 5. subscriptions ──────────────────────────────────────────
create table subscriptions (
  id                     uuid        primary key default gen_random_uuid(),
  user_id                uuid        not null references users(id) on delete cascade unique,
  stripe_customer_id     text,
  stripe_subscription_id text        unique,
  status                 text        not null default 'inactive',
  plan_tier              text        not null default 'free'
                                     check (plan_tier in ('free', 'paid')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create trigger subscriptions_updated_at
  before update on subscriptions
  for each row execute function update_updated_at();

alter table subscriptions enable row level security;

-- ── 6. bots ───────────────────────────────────────────────────
create table bots (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references users(id) on delete cascade,
  bot_name            text        not null,
  description         text,
  status              text        not null default 'awaiting_qr_scan',
  qr_payload          text,
  -- Webhook: WaBot POSTs JSON events here when messages arrive
  webhook_url         text,
  -- Auto-reply
  auto_reply_message  text,
  auto_reply_enabled  boolean     not null default false,
  -- Stats
  messages_count      integer     not null default 0,
  phone_number        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger bots_updated_at
  before update on bots
  for each row execute function update_updated_at();

create index bots_user_id_idx    on bots(user_id);
create index bots_status_idx     on bots(status);

alter table bots enable row level security;

-- ── 7. bot_activity ───────────────────────────────────────────
create table bot_activity (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references users(id) on delete cascade,
  -- bot_id set to null when a bot is deleted (on delete set null)
  bot_id     uuid        references bots(id) on delete set null,
  event_type text        not null,
  details    text,
  created_at timestamptz not null default now()
);

create index bot_activity_user_id_idx    on bot_activity(user_id);
create index bot_activity_bot_id_idx     on bot_activity(bot_id);
create index bot_activity_created_at_idx on bot_activity(created_at desc);

alter table bot_activity enable row level security;

-- ── Done ──────────────────────────────────────────────────────
-- All tables created. RLS is ON but no policies are defined,
-- so the anon/public key has zero access.
-- Our Express backend uses the SERVICE ROLE key which bypasses RLS.
-- Run your backend with the correct env vars and you're good to go.
