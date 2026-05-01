# WwaBot — WhatsApp Bot SaaS Platform

## Project Overview
WwaBot is a full SaaS platform for deploying and managing WhatsApp bots. Users sign up, verify email, deploy bots via QR code scan, and manage everything from a single dark-themed dashboard.

## Architecture

### Frontend (`frontend/`)
- **Stack**: React 18 + Vite 5, no UI library (custom CSS design system)
- **Port**: 5000 (Vite dev server, proxies `/api` → backend:3000)
- **Design**: Dark theme inspired by pxxl.app — deep navy background, purple/pink gradients, pill buttons, Inter font
- **Structure**:
  - `src/styles/globals.css` — complete design system (tokens, components, layout)
  - `src/context/AuthContext.jsx` — JWT auth state (localStorage)
  - `src/api/client.js` — typed `apiFetch` wrapper with error class
  - `src/pages/Landing.jsx` — marketing page (hero, features, pricing)
  - `src/pages/Login.jsx` — sign-in form
  - `src/pages/Signup.jsx` — register form with email flow
  - `src/pages/Verify.jsx` — email verification handler
  - `src/pages/Dashboard.jsx` — full app: sidebar, stats, bots, activity, billing tabs
  - `src/App.jsx` — router with ProtectedRoute + GuestRoute guards

### Backend (`backend/`)
- **Stack**: Express.js (ESM), Node 20, running on port 3000
- **Structure**:
  - `src/config/env.js` — all required env vars validated at startup
  - `src/routes/auth.js` — signup, login, verify, /me
  - `src/routes/bots.js` — dashboard, deploy, GET qr, DELETE
  - `src/routes/billing.js` — Stripe checkout + webhook
  - `src/lib/supabase.js` — Supabase client (service role)
  - `src/lib/brevo.js` — transactional email (WwaBot branded HTML)
  - `src/lib/stripe.js` — Stripe client
  - `src/middleware/auth.js` — JWT Bearer requireAuth middleware
  - `src/utils/jwt.js` — sign/verify access tokens (7d expiry)
  - `src/utils/validators.js` — email, password, name sanitization

## Plan Tiers
| Feature | Free | Pro |
|---------|------|-----|
| Max bots | 2 | 100 |
| Dashboard | ✓ | ✓ |
| QR deployment | ✓ | ✓ |
| Activity feed | ✓ | ✓ |
| Priority support | — | ✓ |
| Stripe billing | — | ✓ |

## Environment Variables Required
### Backend (secrets)
- `JWT_SECRET` — long random string for JWT signing
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key
- `BREVO_API_KEY` — Brevo (Sendinblue) API key
- `BREVO_SENDER_EMAIL` — verified sender email in Brevo
- `STRIPE_SECRET_KEY` — Stripe secret key (sk_test_...)
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret
- `STRIPE_PRICE_ID_GROWTH` — Stripe Price ID for Pro plan

### Backend (env vars, auto-set)
- `PORT=3000`
- `NODE_ENV=development`
- `APP_BASE_URL` — frontend base URL (Replit dev domain)
- `API_BASE_URL=http://localhost:3000`
- `ALLOWED_ORIGINS` — comma-separated allowed CORS origins

### Frontend (env vars)
- `VITE_API_BASE_URL` — defaults to `/api` (proxied by Vite in dev)

## Database (Supabase)
Run `backend/supabase/reset_schema.sql` in the Supabase SQL editor to set up tables:
- `users` — accounts with email verification + plan tier
- `subscriptions` — Stripe subscription records
- `bots` — deployed bot instances
- `bot_activity` — audit log of events

## Security Features
- bcrypt password hashing (cost 12)
- JWT access tokens (7d expiry, HS256)
- Helmet security headers
- HPP HTTP parameter pollution protection
- Rate limiting: 30 req/15min on auth routes, 120 req/min global
- CORS restricted to configured origins
- Email verification required before bot deployment
- Input sanitization on all user-supplied strings
- Ownership checks on all bot operations

## Workflows
- `Start application` — `cd frontend && npm run dev` → port 5000 (webview)
- `Backend API` — `cd backend && npm run dev` → port 3000 (console)
