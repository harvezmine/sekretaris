export const SCHEMA_SQL = /* sql */ `
create table if not exists users (
  id              bigserial primary key,
  wa_id           text unique not null,
  display_name    text,
  timezone        text not null default 'Asia/Jakarta',
  status          text not null default 'new',
  plan            text,
  state           text not null default 'NEW',
  state_data      jsonb not null default '{}'::jsonb,
  consent_at      timestamptz,
  trial_ends_at   timestamptz,
  period_ends_at  timestamptz,
  last_inbound_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table users add column if not exists llm_model text;

create table if not exists messages (
  id          bigserial primary key,
  user_id     bigint not null references users(id) on delete cascade,
  wamid       text unique,
  direction   text not null,
  kind        text not null,
  body        text,
  payload     jsonb,
  processed   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists messages_pending_idx on messages (user_id, id) where direction = 'in' and processed = false;

create table if not exists sessions (
  id              bigserial primary key,
  user_id         bigint not null references users(id) on delete cascade,
  model           text not null,
  snapshot        text not null,
  turns           int not null default 0,
  last_active_at  timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions (user_id, id desc);

create table if not exists transcript (
  id          bigserial primary key,
  session_id  bigint not null references sessions(id) on delete cascade,
  role        text not null,
  content     json not null,
  created_at  timestamptz not null default now()
);
create index if not exists transcript_session_idx on transcript (session_id, id);

create table if not exists captures (
  id            bigserial primary key,
  user_id       bigint not null references users(id) on delete cascade,
  kind          text not null,
  title         text not null,
  mime          text,
  file_path     text,
  size_bytes    bigint,
  page_count    int,
  text_content  text,
  status        text not null default 'ready',
  search        tsvector generated always as (
                  to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || left(coalesce(text_content, ''), 200000))
                ) stored,
  created_at    timestamptz not null default now()
);
create index if not exists captures_search_idx on captures using gin (search);
create index if not exists captures_user_idx on captures (user_id, id desc);

create table if not exists contacts (
  id          bigserial primary key,
  user_id     bigint not null references users(id) on delete cascade,
  name        text not null,
  alias       text,
  phone       text,
  email       text,
  created_at  timestamptz not null default now(),
  unique (user_id, phone)
);

create table if not exists facts (
  id          bigserial primary key,
  user_id     bigint not null references users(id) on delete cascade,
  fact        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists reminders (
  id          bigserial primary key,
  user_id     bigint not null references users(id) on delete cascade,
  kind        text not null default 'user',
  text        text not null,
  fire_at     timestamptz not null,
  status      text not null default 'scheduled',
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists reminders_due_idx on reminders (fire_at) where status = 'scheduled';

create table if not exists redeem_codes (
  code        text primary key,
  kind        text not null,
  trial_days  int,
  max_uses    int not null default 1,
  used_count  int not null default 0,
  expires_at  timestamptz,
  source      text,
  created_at  timestamptz not null default now()
);

create table if not exists redemptions (
  code        text not null references redeem_codes(code) on delete cascade,
  user_id     bigint not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (code, user_id)
);

create table if not exists payments (
  id            bigserial primary key,
  user_id       bigint references users(id) on delete set null,
  provider      text not null,
  provider_ref  text unique not null,
  order_id      text unique not null,
  plan          text not null,
  months        int not null default 1,
  amount_idr    int not null,
  status        text not null default 'pending',
  qr_string     text not null,
  expires_at    timestamptz not null,
  paid_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists payments_user_idx on payments (user_id, id desc);
alter table payments add column if not exists pay_amount_idr int;
alter table payments add column if not exists payment_url text;
alter table payments add column if not exists checked_at timestamptz;

alter table users add column if not exists assistant_name text;
alter table users add column if not exists profile jsonb not null default '{}'::jsonb;
alter table users add column if not exists briefing_sent_on date;
alter table users add column if not exists persona text;
alter table sessions add column if not exists closed_at timestamptz;

alter table reminders add column if not exists repeat text;
alter table reminders add column if not exists repeat_until timestamptz;
alter table reminders add column if not exists series_id bigint;
create index if not exists reminders_series_idx on reminders (series_id) where status = 'scheduled';


create table if not exists relay_messages (
  id            bigserial primary key,
  owner_id      bigint not null references users(id) on delete cascade,
  to_wa         text not null,
  contact_name  text,
  body          text not null,
  status        text not null default 'pending',
  wamid         text,
  error         text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  sent_at       timestamptz,
  acked_at      timestamptz
);
create index if not exists relay_messages_to_idx on relay_messages (to_wa, sent_at desc) where status = 'sent';

create table if not exists relay_replies (
  id          bigserial primary key,
  relay_id    bigint not null references relay_messages(id) on delete cascade,
  owner_id    bigint not null references users(id) on delete cascade,
  from_wa     text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  seen_at     timestamptz
);
create index if not exists relay_replies_unseen_idx on relay_replies (owner_id) where seen_at is null;

create table if not exists google_accounts (
  user_id             bigint primary key references users(id) on delete cascade,
  email               text,
  scopes              text[] not null default '{}',
  refresh_token_enc   text,
  access_token_enc    text,
  access_expires_at   timestamptz,
  status              text not null default 'active',
  last_error          text,
  expired_notified_at timestamptz,
  connected_at        timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists oauth_states (
  id             text primary key,
  user_id        bigint not null references users(id) on delete cascade,
  services       text[] not null,
  code_verifier  text not null,
  created_at     timestamptz not null default now(),
  used_at        timestamptz
);

create table if not exists pending_actions (
  id          bigserial primary key,
  user_id     bigint not null references users(id) on delete cascade,
  kind        text not null,
  payload     jsonb not null,
  status      text not null default 'pending',
  result      text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists pending_actions_user_idx on pending_actions (user_id, id desc);

create table if not exists user_servers (
  id               bigserial primary key,
  user_id          bigint not null references users(id) on delete cascade,
  name             text not null,
  description      text not null default '',
  host             text not null,
  port             int not null default 22,
  username         text not null,
  private_key_enc  text not null,
  public_key       text not null,
  host_key         text,
  verified_at      timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists agent_runs (
  id           bigserial primary key,
  user_id      bigint references users(id) on delete set null,
  session_id   bigint references sessions(id) on delete set null,
  model        text not null,
  steps        int not null default 0,
  stop_reason  text,
  served_by    text,
  soft_mode    boolean not null default false,
  cost_usd     numeric(12, 6) not null default 0,
  latency_ms   int,
  error        text,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists agent_runs_user_idx on agent_runs (user_id, created_at);

create table if not exists usage_ledger (
  id              bigserial primary key,
  user_id         bigint references users(id) on delete set null,
  run_id          bigint references agent_runs(id) on delete set null,
  kind            text not null,
  model           text,
  input_tokens    int not null default 0,
  cache_write_5m  int not null default 0,
  cache_write_1h  int not null default 0,
  cache_read      int not null default 0,
  output_tokens   int not null default 0,
  units           numeric,
  cost_usd        numeric(12, 6) not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists usage_ledger_created_idx on usage_ledger (created_at);

alter table user_servers add column if not exists actions jsonb not null default '[]'::jsonb;

create table if not exists server_runs (
  id           bigserial primary key,
  user_id      bigint not null references users(id) on delete cascade,
  server_name  text not null,
  action_name  text,
  command      text not null,
  exit_code    int,
  duration_ms  int,
  output       text,
  error        text,
  created_at   timestamptz not null default now()
);
create index if not exists server_runs_user_idx on server_runs (user_id, id desc);

create table if not exists routine_log (
  user_id  bigint not null references users(id) on delete cascade,
  kind     text not null,
  on_date  date not null,
  sent     boolean not null default true,
  at       timestamptz not null default now(),
  primary key (user_id, kind, on_date)
);
`;
