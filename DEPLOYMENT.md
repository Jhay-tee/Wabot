# WaBot Deployment Guide

WaBot is a split deployment monorepo:

- `frontend/` → Vercel (Vite/React SPA)
- `backend/` → Render or another Node host (Express API)
- `backend/supabase/schema.sql` → Supabase PostgreSQL schema
- Brevo → transactional email
- Paystack → subscriptions for Pro billing

## 1. Supabase

1. Create a Supabase project.
2. Copy your project URL and service role key.
3. Run the full contents of `backend/supabase/schema.sql` in the SQL editor.

The schema file is the single canonical SQL file for the whole app.
It also prepares all core WaBot tables for Supabase Realtime by setting replica identity and adding them to the `supabase_realtime` publication.

## 2. Backend

Deploy the `backend/` folder as a Node 20+ service.

Required environment variables:

```env
NODE_ENV=production
PORT=10000
APP_BASE_URL=https://your-frontend-domain.vercel.app
API_BASE_URL=https://your-backend-domain.onrender.com
ALLOWED_ORIGINS=https://your-frontend-domain.vercel.app
JWT_SECRET=replace-with-a-strong-random-secret
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
BREVO_API_KEY=your-brevo-key
BREVO_SENDER_EMAIL=hello@yourdomain.com
BREVO_SENDER_NAME=WaBot
PAYSTACK_SECRET_KEY=sk_live_xxx
PAYSTACK_WEBHOOK_SECRET=your-paystack-webhook-secret
PAYSTACK_PLAN_CODE=PLN_xxxxxxxxxx
SUPERADMIN_EMAIL=you@yourdomain.com
```

Notes:

- `APP_BASE_URL` must point to the frontend, because email verification and billing redirects return there.
- `ALLOWED_ORIGINS` should include every frontend domain allowed to call the API.
- WhatsApp sessions are persisted in Supabase via `bot_sessions`, so connected bots can recover across server restarts.

## 3. Frontend

Deploy the `frontend/` folder as a Vite app.

Set:

```env
VITE_API_BASE_URL=https://your-backend-domain.onrender.com
```

That variable is required for split deployment so browser requests, docs examples, and SSE all target the backend correctly. Adding `/api` is also fine; the frontend normalizes either form.

## 4. Paystack

1. Create a monthly Paystack plan for `₦1,500`.
2. Set the returned plan code as `PAYSTACK_PLAN_CODE`.
3. Configure the webhook URL as:

```text
https://your-backend-domain.onrender.com/api/billing/webhook
```

Recommended events:

- `charge.success`
- `subscription.disable`
- `subscription.not_renew`
- `invoice.payment_failed`

## 5. Verification Checklist

- `GET /api/health` returns `ok: true`
- Signup sends a verification email
- Login returns a JWT after verification
- Dashboard loads on the frontend using `VITE_API_BASE_URL`
- API keys can be created and used against `/api/v1/*`
- Paystack checkout opens and webhooks upgrade/downgrade plans correctly
- Bot QR, status SSE, and message sending work from separate frontend/backend domains

## 6. Commit Checklist

Commit these:

- `frontend/src/`, `backend/src/`, `backend/supabase/schema.sql`
- `frontend/package.json`, `frontend/package-lock.json`
- `backend/package.json`, `backend/package-lock.json`
- `.gitignore`, `DEPLOYMENT.md`, `backend/.env.example`, `frontend/.env.example`

Do not commit these:

- `backend/.env`, `frontend/.env`
- `node_modules/`
- `frontend/dist/`, `backend/dist/`
- `backend/sessions/`
- `.vercel/`, `frontend/.vercel/`, `backend/.vercel/`
- local logs, temp files, editor state, or copied secrets
