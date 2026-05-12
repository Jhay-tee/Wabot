# WaBot Backend Setup

## What lives here

- `backend/` → Express API, auth, bots, developer API, billing
- `backend/supabase/schema.sql` → single canonical SQL file for the full app

## Local setup

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

## Required services

- Supabase for database and auth admin operations
- Brevo for verification email delivery
- Paystack for Pro subscriptions

## Database

Run `backend/supabase/schema.sql` in Supabase before using the backend.

## Production notes

- Set `APP_BASE_URL` to the frontend domain.
- Set `API_BASE_URL` to the backend domain.
- Set `ALLOWED_ORIGINS` to the frontend domains allowed to call the API.
- Set `PAYSTACK_PLAN_CODE`, `PAYSTACK_SECRET_KEY`, and `PAYSTACK_WEBHOOK_SECRET` to enable paid billing.
- API keys and `/api/v1/*` endpoints are plan-aware and rate-limited.
