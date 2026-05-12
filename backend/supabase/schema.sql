-- ============================================================
--  WaBot — Canonical Application Schema
--  Run this single file in the Supabase SQL Editor for a clean,
--  production-ready setup of the full application database.
--  WARNING: Drops existing WaBot tables and recreates them.
-- ============================================================

drop table if exists message_templates cascade;
drop table if exists bot_activity     cascade;
drop table if exists bot_sessions     cascade;
drop table if exists bots             cascade;
drop table if exists api_keys         cascade;
drop table if exists subscriptions    cascade;
drop table if exists users            cascade;

drop function if exists update_updated_at()            cascade;
drop function if exists enforce_api_key_limit()        cascade;
drop function if exists enforce_bot_limit()            cascade;
drop function if exists increment_user_messages()      cascade;
drop function if exists increment_user_messages_by()   cascade;
drop function if exists increment_bot_messages()       cascade;
drop function if exists increment_bot_messages_by()    cascade;

create extension if not exists "pgcrypto";

create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table users (
  id                   uuid        primary key,
  email                text        not null unique,
  full_name            text        not null default '',
  email_verified       boolean     not null default false,
  verification_token   text        unique,
  plan_tier            text        not null default 'free'
                                   check (plan_tier in ('free', 'paid')),
  messages_this_month  integer     not null default 0,
  billing_period_start timestamptz not null default date_trunc('month', now()),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger users_updated_at
  before update on users
  for each row execute function update_updated_at();

create index users_email_idx on users(email);
create index users_verification_token_idx on users(verification_token)
  where verification_token is not null;

alter table users enable row level security;

create table api_keys (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references users(id) on delete cascade,
  name        text        not null,
  key_hash    text        not null unique,
  key_prefix  text        not null,
  last_used   timestamptz,
  created_at  timestamptz not null default now()
);

create or replace function enforce_api_key_limit()
returns trigger language plpgsql as $$
declare
  user_plan  text;
  key_count  int;
  max_keys   int;
begin
  select plan_tier into user_plan from users where id = new.user_id;
  select count(*) into key_count from api_keys where user_id = new.user_id;
  max_keys := case when user_plan = 'paid' then 10 else 1 end;
  if key_count >= max_keys then
    raise exception 'API key limit reached for plan: %', user_plan;
  end if;
  return new;
end;
$$;

create trigger api_keys_limit_check
  before insert on api_keys
  for each row execute function enforce_api_key_limit();

create index api_keys_user_id_idx  on api_keys(user_id);
create index api_keys_key_hash_idx on api_keys(key_hash);

alter table api_keys enable row level security;

create table subscriptions (
  id                          uuid        primary key default gen_random_uuid(),
  user_id                     uuid        not null references users(id) on delete cascade unique,
  paystack_customer_code      text,
  paystack_subscription_code  text        unique,
  status                      text        not null default 'inactive'
                                          check (status in ('active', 'inactive', 'canceled', 'past_due')),
  plan_tier                   text        not null default 'free'
                                          check (plan_tier in ('free', 'paid')),
  current_period_end          timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create trigger subscriptions_updated_at
  before update on subscriptions
  for each row execute function update_updated_at();

alter table subscriptions enable row level security;

create table bots (
  id                      uuid        primary key default gen_random_uuid(),
  user_id                 uuid        not null references users(id) on delete cascade,
  bot_name                text        not null,
  description             text        default '',
  status                  text        not null default 'awaiting_qr_scan'
                                       check (status in (
                                         'awaiting_qr_scan', 'connecting',
                                         'connected', 'disconnected', 'error'
                                       )),
  phone_number            text,
  webhook_url             text,
  webhook_secret          text,
  auto_reply_enabled      boolean     not null default false,
  auto_reply_message      text        default '',
  bot_type                text        not null default 'dm'
                                       check (bot_type in ('dm', 'group', 'all')),
  keyword_triggers        jsonb       not null default '[]',
  sales_agent_config      jsonb       not null default '{}',
  commands_config         jsonb       not null default '{}',
  ai_config               jsonb       not null default '{}',
  group_management_config jsonb       not null default '{}',
  website_url             text,
  catalog_unavail_msg     text,
  messages_count          bigint      not null default 0,
  messages_this_month     bigint      not null default 0,
  last_activity           timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create or replace function enforce_bot_limit()
returns trigger language plpgsql as $$
declare
  user_plan  text;
  bot_count  int;
  max_bots   int;
begin
  select plan_tier into user_plan from users where id = new.user_id;
  select count(*) into bot_count from bots where user_id = new.user_id;
  max_bots := case when user_plan = 'paid' then 50 else 1 end;
  if bot_count >= max_bots then
    raise exception 'Bot limit reached for plan: % (max: %)', user_plan, max_bots;
  end if;
  return new;
end;
$$;

create trigger bots_limit_check
  before insert on bots
  for each row execute function enforce_bot_limit();

create trigger bots_updated_at
  before update on bots
  for each row execute function update_updated_at();

create index bots_user_id_idx on bots(user_id);
create index bots_status_idx  on bots(status);

alter table bots enable row level security;

create table bot_sessions (
  id         uuid        primary key default gen_random_uuid(),
  bot_id     uuid        not null references bots(id) on delete cascade unique,
  creds      jsonb       not null default '{}',
  keys       jsonb       not null default '{}',
  updated_at timestamptz not null default now()
);

create trigger bot_sessions_updated_at
  before update on bot_sessions
  for each row execute function update_updated_at();

create index bot_sessions_bot_id_idx on bot_sessions(bot_id);

alter table bot_sessions enable row level security;

create table bot_activity (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references users(id) on delete cascade,
  bot_id      uuid        references bots(id) on delete set null,
  event_type  text        not null,
  details     text,
  metadata    jsonb       default '{}',
  created_at  timestamptz not null default now()
);

create index bot_activity_user_id_idx    on bot_activity(user_id);
create index bot_activity_bot_id_idx     on bot_activity(bot_id);
create index bot_activity_created_at_idx on bot_activity(created_at desc);
create index bot_activity_event_type_idx on bot_activity(event_type);

alter table bot_activity enable row level security;

create table message_templates (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references users(id) on delete cascade,
  name        text        not null,
  content     text        not null,
  variables   jsonb       not null default '[]',
  use_count   integer     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint message_templates_user_name_unique unique (user_id, name)
);

create index message_templates_user_id_idx on message_templates(user_id);

create trigger message_templates_updated_at
  before update on message_templates
  for each row execute function update_updated_at();

alter table message_templates enable row level security;

-- Realtime readiness:
-- - REPLICA IDENTITY FULL ensures update/delete payloads include full row data.
-- - Adding tables to the supabase_realtime publication makes them streamable
--   once Realtime is enabled in the Supabase dashboard/project settings.
alter table users             replica identity full;
alter table api_keys          replica identity full;
alter table subscriptions     replica identity full;
alter table bots              replica identity full;
alter table bot_sessions      replica identity full;
alter table bot_activity      replica identity full;
alter table message_templates replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table users;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table api_keys;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table subscriptions;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table bots;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table bot_sessions;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table bot_activity;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table message_templates;
  exception when duplicate_object then null;
  end;
end $$;

create or replace function increment_user_messages(uid uuid)
returns void language sql security definer as $$
  update users set messages_this_month = coalesce(messages_this_month, 0) + 1 where id = uid;
$$;

create or replace function increment_user_messages_by(uid uuid, amount int)
returns void language sql security definer as $$
  update users set messages_this_month = coalesce(messages_this_month, 0) + amount where id = uid and amount > 0;
$$;

create or replace function increment_bot_messages(bid uuid)
returns void language sql security definer as $$
  update bots set messages_count = coalesce(messages_count, 0) + 1 where id = bid;
$$;

create or replace function increment_bot_messages_by(bid uuid, amount int)
returns void language sql security definer as $$
  update bots
  set messages_count = coalesce(messages_count, 0) + amount
  where id = bid and amount > 0;
$$;

-- Passwords are managed by Supabase Auth and never stored here.
