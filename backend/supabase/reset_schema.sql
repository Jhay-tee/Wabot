-- WARNING: This drops old SaaS tables and recreates them.
drop table if exists bot_activity cascade;
drop table if exists bots cascade;
drop table if exists subscriptions cascade;
drop table if exists users cascade;

create extension if not exists "pgcrypto";

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  full_name text,
  email_verified boolean not null default false,
  verification_token text unique,
  plan_tier text not null default 'free' check (plan_tier in ('free', 'paid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade unique,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  status text not null default 'inactive',
  plan_tier text not null default 'free' check (plan_tier in ('free', 'paid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table bots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  bot_name text not null,
  status text not null default 'awaiting_qr_scan',
  qr_payload text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table bot_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  bot_id uuid references bots(id) on delete cascade,
  event_type text not null,
  details text,
  created_at timestamptz not null default now()
);

create index bots_user_id_idx on bots(user_id);
create index bot_activity_user_id_idx on bot_activity(user_id);
