# Wabot - WhatsApp Group Management Bot

A powerful and stable WhatsApp bot built with **@whiskeysockets/baileys** and **Supabase** for group management.

---

## ✨ Features

- **Group Management Commands**
  - Kick members
  - Delete messages (reply)
  - Lock / Unlock group
  - Schedule auto-lock & auto-unlock
  - Anti-Link protection with strike system
  - Anti-Vulgar (bad words) filter
  - Tag all members (`.tagall`)
  - Strike system with auto-kick after 3 strikes

- **Admin Controls**
  - Toggle bot on/off per group
  - Toggle anti-link per group

- **Persistent Session**
  - Session saved in Supabase (no need to scan QR every time)

- **Scheduler**
  - Automatic group locking/unlocking based on schedule

- **Stable Hosting Ready**
  - Optimized for Render.com with auto-reconnect and debounce saving

---

## 🛠️ Tech Stack

- **Node.js** (v18+)
- **@whiskeysockets/baileys** - WhatsApp Web API
- **Supabase** - Database & Session Storage
- **Express.js** - Simple web dashboard for QR
- **Pino** - Logging

---

## 📋 Prerequisites

- Node.js >= 18
- Supabase Project (with tables: `wa_sessions`, `group_settings`, `group_strikes`, `group_scheduled_locks`)
- Render.com account (recommended for 24/7 hosting)

---

## 🚀 Installation & Setup

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd wabot
   Install dependenciesBashnpm install
Create .env fileenvSUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
LOG_LEVEL=info
Run locallyBashnpm run dev
Scan QR Code
Open http://localhost:3000 in browser
Scan the QR with your WhatsApp



📜 Available Commands
Admin Only:

.kick @user → Remove member
.delete (reply) → Delete message
.bot on/off → Enable/Disable bot
.link on/off → Enable/Disable anti-link
.lock / .unlock → Lock or unlock group
.locktime YYYY-MM-DD HH:mm → Schedule auto-lock
.unlocktime YYYY-MM-DD HH:mm → Schedule auto-unlock
.strike @user → Add strike
.resetstrikes @user → Reset strikes

Everyone:

.tagall → Mention all members
.help → Show all commands


🗄️ Database Tables

wa_sessions → Stores WhatsApp session
group_settings → Per-group settings (bot_active, anti_link, etc.)
group_strikes → Strike count per user
group_scheduled_locks → Scheduled lock/unlock times


🚀 Deploy on Render

Connect your GitHub repo to Render
Set Environment Variables (SUPABASE_URL, SUPABASE_ANON_KEY)
Set Start Command: npm start
Add a cron job to ping /health every 10 minutes (to prevent sleep)


📁 Project Structure
textwabot/
├── index.js
├── session.js
├── db.js
├── commands.js
├── antiSpam.js
├── scheduler.js
├── utils.js
├── logger.js
├── config.js
├── .env
└── package.json

🤝 Contributing
Feel free to open issues and pull requests!


Made with ❤️ for group management