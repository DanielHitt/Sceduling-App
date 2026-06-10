# Office Scheduler

A dead-simple appointment scheduler for a small medical office. Open it from any
device via a URL, see the week at a glance, and change appointments in seconds —
with email notifications to patients built in.

## What it does

- **Week & day calendar** — week view colored by provider, day view with a column
  per provider/room. Click an empty slot to book, click an appointment to edit.
- **Multiple providers/rooms** — add as many as you need in Settings; filter the
  calendar with one tap.
- **Recurring appointments** — weekly or every-2-weeks series. When editing, choose
  "only this one", "this + following", or "all".
- **Patient messaging** — if a phone or email is on the appointment:
  - *Send email now* — sends a confirmation / change notice / cancellation /
    reminder directly from the app (via Resend).
  - *Open email app / Open texting app* — opens a pre-filled message on the staff
    member's own device. Works with zero setup, no account needed.
- **Automatic reminders** — patients with an email on file get a reminder
  N hours before their appointment (configurable in Settings, default 24h).
- **Live sync** — multiple front-desk screens update in real time.
- **Staff-only access** — email/password logins; no public sign-up.

## Tech

React + Vite + Tailwind frontend (host anywhere static — Vercel/Netlify free tier).
Supabase for the database, staff auth, edge functions (email), and scheduled
reminders. Everything fits in free tiers for a small office.

## Running locally

```bash
cp .env.example .env   # already points at the dev Supabase project
npm install
npm run dev
```

## Deploying the frontend

`npm run build` produces a static site in `dist/`. On Vercel or Netlify: import the
repo, framework = Vite, and set the two `VITE_*` environment variables from `.env.example`.

## Setting up a fresh Supabase project (recommended for the real office)

The app is currently wired to a development Supabase project. **Patient data should
live in its own dedicated project, ideally under the doctor's own (free) Supabase
account.** It takes about 5 minutes:

1. Create a project at [supabase.com](https://supabase.com).
2. SQL Editor → paste and run `supabase/migrations/0001_init.sql`. Then run the
   commented-out `cron.schedule` block at the bottom after filling in your project
   ref and anon key (Dashboard → Settings → API).
3. Deploy the two edge functions (with the [Supabase CLI](https://supabase.com/docs/guides/functions/deploy)):
   `supabase functions deploy send-message` and `supabase functions deploy send-reminders`.
4. Update `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env` (local)
   and in your Vercel/Netlify env vars (Settings → API in the Supabase dashboard).

## Enabling email sending (one-time setup)

Manual "Open email app / texting app" buttons work with no setup at all. For the
in-app **Send email now** button and **automatic reminders**:

1. Create a free [Resend](https://resend.com) account (3,000 emails/month free).
2. Verify the office's domain (or use Resend's test address to try it out).
3. In the Supabase dashboard → Edge Functions → Secrets, add:
   - `RESEND_API_KEY` — from the Resend dashboard
   - `FROM_EMAIL` — e.g. `Front Desk <office@yourdomain.com>`

Until those are set, the app shows a friendly "not configured" message and the
manual buttons still work.

## Creating staff accounts

There is intentionally no sign-up page. In the Supabase dashboard:

1. Authentication → Sign In / Up → **disable** "Allow new users to sign up"
   (so nobody can self-register through the API).
2. Authentication → Users → **Add user** → enter the staff member's email and a
   password (or send an invite). Share the app URL + credentials with them.

Every staff account has full access to the schedule.

## A note on patient privacy

This app stores patient names, contact info, and appointment notes. Keep the data
in a dedicated Supabase project controlled by the practice, create individual staff
accounts (not shared ones) so access can be revoked, and avoid putting clinical
details in the notes field. If the practice is subject to HIPAA, be aware that the
free tiers of Supabase/Resend do not come with a BAA — a paid plan with a signed
BAA (or keeping notes strictly non-clinical) would be needed for compliance.
