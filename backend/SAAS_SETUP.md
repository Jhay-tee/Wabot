# Botify SaaS Setup

This project now includes:

- `frontend/` - React + Vite app (landing page, auth pages, dashboard, bot deployment, theme toggle)
- `backend/` - Express API (auth, verification, bots, billing + Stripe webhook)
- `backend/supabase/reset_schema.sql` - drops old SaaS tables and recreates schema used by this app

## 1) Environment

- Backend: copy `backend/.env.example` to `backend/.env`
- Frontend: copy `frontend/.env.example` to `frontend/.env`

## 2) Supabase

Run `backend/supabase/reset_schema.sql` in the Supabase SQL editor.

## 3) Install & Run

Backend:

```bash
cd backend
npm install
npm run dev
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

## 4) Stripe

- Create Growth price in Stripe and set `STRIPE_PRICE_ID_GROWTH`.
- Set webhook endpoint to `https://your-backend-domain/api/billing/webhook`.
- Subscribe to:
  - `checkout.session.completed`
  - `customer.subscription.deleted`

## 5) Brevo

- Create sender identity in Brevo.
- Set `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`.

## Notes

- New users must verify email before `/api/bots/deploy` is allowed.
- Free plan allows 2 bots; paid allows 100 bots (adjust in `backend/src/routes/bots.js`).
- QR generation is implemented and returned as Data URL for frontend display.
