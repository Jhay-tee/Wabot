# WaBot

WaBot is a production-focused WhatsApp automation platform for businesses, creators, agencies, and developers who want to deploy bots quickly, manage them from a clean dashboard, and extend them with a developer API.

It is built as a split-deployment monorepo:

- `frontend/` is a Vite + React dashboard and marketing site
- `backend/` is an Express API and WhatsApp bot runtime
- `backend/supabase/schema.sql` is the canonical Supabase schema for the app

WaBot is designed around a simple idea: deploy a WhatsApp bot fast, scan a QR code, and start handling messages with commands, catalog replies, keyword automation, API calls, and optional AI responses.

## What WaBot Does

WaBot helps you:

- deploy WhatsApp bots for direct messages, groups, or both
- manage bots from a browser dashboard
- expose bot functionality through a REST API with API key auth
- automate replies with commands, keyword triggers, welcome messages, and auto-replies
- run a lightweight sales flow with a product catalog and product lookup
- receive inbound events through webhooks
- offer Pro-only AI replies using OpenAI or Gemini
- handle free and paid plans with Paystack billing

## Core Features

### Bot deployment

- QR-based WhatsApp bot deployment
- bot types: `dm`, `group`, or `all`
- persisted bot sessions in Supabase so bots can recover after server restarts
- live status updates through SSE

### Dashboard

- deploy and configure bots
- view per-bot status, message counts, monthly usage, and recent activity
- manage webhook configuration
- manage commands, keyword triggers, sales catalog, and auto-replies
- create and rotate developer API keys
- view free vs Pro plan state and billing details

### Sales agent

- product catalog with name, price, and description
- catalog replies from `/catalog`, `/price`, and natural product queries
- configurable “product not available” responses
- welcome messages for first-time DM contacts
- optional group welcome messages

### Group management

WaBot supports built-in group moderation and admin commands when the bot is a group admin:

- `.help`
- `.kick`
- `.ban`
- `.lock`
- `.unlock`
- `.promote`
- `.demote`
- `.warn`
- `.warnings`
- `.clearwarn`
- `.tagall`
- `.rules`
- `.admins`

It also supports:

- anti-link moderation
- anti-spam moderation
- anti-vulgar word filtering
- strike-based auto-removal rules

### Developer API

WaBot exposes a REST API for automation and integration use cases.

Examples include:

- send a direct WhatsApp message
- send OTP messages
- send form submission alerts to WhatsApp
- send welcome messages
- list bots
- fetch bot stats
- manage templates
- test webhook destinations

Authentication supports:

- dashboard JWTs for first-party usage
- API keys starting with `wbk_`

### AI replies

Pro users can connect provider keys from the dashboard and allow bots to answer chats automatically when no command or trigger matches.

Supported providers:

- OpenAI
- Google Gemini

Security behavior:

- provider keys are encrypted before storage
- stored keys are never returned in readable form
- keys can be replaced, but not viewed later

### Billing

- free plan available
- Pro billing via Paystack
- graceful fallback when billing is not configured yet
- upgrade attempts show a friendly popup when Pro billing is unavailable

## Plans

### Free

- 1 bot
- 1,000 messages per month
- 1 API key
- commands
- keyword triggers
- webhooks
- product catalog
- activity tracking

### Pro

- up to 50 bots
- 100,000 messages per month
- 10 API keys
- AI replies
- broadcast support
- custom command responses
- higher API rate limits
- subscription management

## Monorepo Structure

```text
.
├── backend/
│   ├── src/
│   ├── supabase/
│   │   └── schema.sql
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── src/
│   ├── package.json
│   └── .env.example
├── DEPLOYMENT.md
└── README.md
```

## Tech Stack

### Frontend

- React
- React Router
- Vite

### Backend

- Node.js
- Express
- `@whiskeysockets/baileys` for WhatsApp connectivity
- Supabase for database and session persistence
- Supabase Realtime-ready table configuration for live subscriptions
- Brevo for verification emails
- Paystack for billing

## Architecture

WaBot uses a split deployment model:

- frontend on Vercel
- backend on Render or another Node host
- Supabase as the main datastore

Typical flow:

1. A user signs up on the frontend.
2. The backend creates the account and sends a verification email through Brevo.
3. The user deploys a bot from the dashboard.
4. The backend creates a bot record and starts a WhatsApp session.
5. The user scans the QR code.
6. Incoming WhatsApp events are handled by the backend and optionally forwarded to webhooks or AI providers.
7. Developer API clients can interact with bots through `/api/v1/*`.

If Supabase Realtime is enabled in your project, the main WaBot tables are already prepared to broadcast useful update and delete payloads.

## Local Development

### Requirements

- Node.js 20+
- a Supabase project
- optional: Brevo account for email
- optional: Paystack account for billing

### 1. Install dependencies

Backend:

```bash
cd backend
npm install
```

Frontend:

```bash
cd frontend
npm install
```

### 2. Configure environment variables

Backend:

```bash
cp backend/.env.example backend/.env
```

Frontend:

```bash
cp frontend/.env.example frontend/.env
```

Notes:

- in local development, leave `VITE_API_BASE_URL` empty
- the Vite dev server proxies `/api` to the backend

### 3. Create the database schema

Run the full contents of:

`backend/supabase/schema.sql`

in your Supabase SQL editor.

This is the single canonical SQL file for the app.
It also prepares the core WaBot tables for Supabase Realtime by:

- setting `REPLICA IDENTITY FULL`
- adding the tables to the `supabase_realtime` publication

### 4. Start the backend

```bash
cd backend
npm run dev
```

### 5. Start the frontend

```bash
cd frontend
npm run dev
```

## Deployment

See [DEPLOYMENT.md](/home/akpan-jonathan/Downloads/Wabot-2/DEPLOYMENT.md) for the full deployment guide.

High-level deployment layout:

- deploy `frontend/` to Vercel
- deploy `backend/` to Render or another Node host
- set `VITE_API_BASE_URL` to your backend URL ending in `/api`
- set backend environment variables for Supabase, Brevo, and optionally Paystack

## Environment Variables

Key backend variables:

- `PORT`
- `NODE_ENV`
- `APP_BASE_URL`
- `API_BASE_URL`
- `ALLOWED_ORIGINS`
- `JWT_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BREVO_API_KEY`
- `BREVO_SENDER_EMAIL`
- `BREVO_SENDER_NAME`
- `PAYSTACK_SECRET_KEY`
- `PAYSTACK_WEBHOOK_SECRET`
- `PAYSTACK_PLAN_CODE`
- `SUPERADMIN_EMAIL`

Key frontend variable:

- `VITE_API_BASE_URL`

See:

- [backend/.env.example](/home/akpan-jonathan/Downloads/Wabot-2/backend/.env.example)
- [frontend/.env.example](/home/akpan-jonathan/Downloads/Wabot-2/frontend/.env.example)

## Security Model

WaBot includes several production-oriented security decisions:

- JWT auth for dashboard access
- API key auth for developer API access
- API keys stored as hashes, not plaintext
- AI provider keys encrypted before storage
- webhook signing with HMAC
- Helmet, HPP, compression, and CORS handling in the backend
- rate limiting for auth, dashboard, admin, and public API usage
- SSRF protection on webhook test endpoints

Important behavior:

- saved AI keys cannot be viewed again
- API keys cannot be retrieved in plaintext after creation
- API keys can be rotated or replaced

## Developer API Overview

Base path:

```text
/api/v1
```

Examples of supported endpoints:

- `POST /messages/send`
- `POST /messages/otp`
- `POST /messages/form-submission`
- `POST /messages/welcome`
- `POST /messages/broadcast`
- `GET /bots`
- `GET /bots/:id`
- `GET /bots/:id/stats`
- `GET /bots/:id/config`
- `PATCH /bots/:id/config`
- `GET /templates`
- `POST /templates`
- `PATCH /templates/:id`
- `DELETE /templates/:id`
- `POST /webhooks/test`

The send API is intentionally flexible so it can support:

- OTP delivery
- internal notification flows
- form submission routing
- welcome flows
- general business messaging

For user-facing examples, see the in-app docs page at `/docs`.

## Performance Notes

Recent runtime behavior is designed to stay efficient:

- bot sessions are restored only when there is a persisted session to recover
- bot activity logs are batched before writing to Supabase
- bot usage counters are batched instead of written for every single event
- QR and status updates stream over SSE

## What To Commit

Commit these:

- `frontend/src/`
- `backend/src/`
- `backend/supabase/schema.sql`
- `frontend/package.json`
- `frontend/package-lock.json`
- `backend/package.json`
- `backend/package-lock.json`
- `.gitignore`
- `DEPLOYMENT.md`
- `README.md`
- `.env.example` files

Do not commit these:

- `backend/.env`
- `frontend/.env`
- `node_modules/`
- `frontend/dist/`
- `backend/dist/`
- `backend/sessions/`
- `.vercel/`
- logs
- local temp files
- copied secrets

## Current Product Positioning

WaBot is a good fit for:

- small businesses handling customer chats on WhatsApp
- agencies managing multiple bots for clients
- sales teams that want lightweight catalog automation
- developers who want a WhatsApp messaging layer with a REST API

## In Short

WaBot is a full-stack WhatsApp bot platform with:

- a dashboard
- a developer API
- product catalog automation
- group moderation tools
- Pro AI replies
- plan-aware limits
- production-oriented deployment and persistence

It aims to make WhatsApp automation easy for non-developers while still giving developers the control they need.
