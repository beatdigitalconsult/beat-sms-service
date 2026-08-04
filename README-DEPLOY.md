========================================================
  BEAT SMS — Hosted ID Card & Cloud Backup Service
  by Beat Digital Consult
========================================================

WHAT THIS IS
------------------------------------------------------------
A small, always-online web service with two jobs:
  1. Give every Digital ID card (student or staff) a permanent
     public verification link. Scanning the card's QR code opens a
     live page here showing the person's photo, name, ID number,
     role/class, and whether their school's license is active.
  2. Let a school back up its full BEAT SMS data (students, staff,
     classes, attendance, fees, payroll, etc.) to the cloud and
     restore it on another PC — keyed by that school's license key.

Everything else in BEAT SMS keeps working fully offline exactly as
before — this service is only needed for the "cloud" parts: hosted
ID card links and cloud backup/restore. Without it, ID cards still
work using an offline QR code, they just won't have a scannable
public page.

I (Claude) wrote and tested this code, but I can't click "Deploy"
for you — I don't have the ability to reach the internet or create
accounts on your behalf. The steps below take about 10 minutes.

------------------------------------------------------------
OPTION A — DEPLOY ON RENDER.COM (recommended, has a free tier)
------------------------------------------------------------
1. Create a free account at https://render.com.

2. Put this "hosting-service" folder in its own GitHub repo:
     - Create a new repo, e.g. "beat-sms-service"
     - Upload everything inside this folder (server.js,
       package.json, .env.example, data/) to that repo
   (GitHub's "Add file → Upload files" in the browser works fine —
   no coding needed.)

3. In Render: New → Web Service → connect that GitHub repo.
     - Name: beat-sms-service (or anything you like)
     - Runtime: Node
     - Build Command:  npm install
     - Start Command:  npm start
     - Instance Type: Free to start (see "MAKING DATA PERMANENT"
       below before relying on it for real client data)

4. Click "Create Web Service". Render will build and deploy it.
   When it's done you'll get a URL like:
     https://beat-sms-service.onrender.com

5. Test it: open that URL — you should see the branded "BEAT SMS —
   ID Card Service" page. Then open
     https://beat-sms-service.onrender.com/healthz
   and confirm it replies with JSON showing "ok": true.

   ⚠️ CRITICAL — DO THIS BEFORE RELYING ON IT: by itself, this
   deployment WILL lose every ID card and backup on restart. Read
   "MAKING DATA PERMANENT" right below — it takes 5 minutes and is
   free.

------------------------------------------------------------
MAKING DATA PERMANENT — REQUIRED FOR REAL USE
------------------------------------------------------------
Render's FREE web services have a completely ephemeral filesystem
and can restart at any time. Every time that happens, any ID card
or backup saved only to the local file is gone — this is why cards
can look "unstable" (working right after publishing, then
"card not found" a while later).

THE FIX (free, ~5 minutes — server.js already supports it, you
just need the database and one environment variable). You already
have a MongoDB Atlas project set up — this uses that same account:

1. Open your Atlas project: https://cloud.mongodb.com
   (the project you're already using for Beat Management System
   works fine — a new database "beat_sms" is created automatically
   inside it, completely separate from BMS's "beat_management_system"
   database, so the two products never mix data).

2. If you don't already have a free "M0" cluster in this project,
   create one (Database → Create) — free forever, no credit card.

3. Database Access → Add New Database User → set a username and
   password (save these — you'll need them in step 5). You can
   reuse the same database user BMS already uses, or make a new one.

4. Network Access → Add IP Address → "Allow Access From Anywhere"
   (0.0.0.0/0). Required because Render's servers don't have a
   fixed IP address. (Skip this step if you already did it for BMS
   in the same Atlas project — one entry covers both services.)

5. Go to your cluster → Connect → "Drivers" → copy the connection
   string. It looks like:
     mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/
   Replace <username> and <password> with the values from step 3.

6. In Render: your service → Environment → Add Environment
   Variable:
     MONGODB_URI = <the connection string from step 5>

7. Render redeploys automatically. Check the service logs — you
   should see:
     ✅ Connected to MongoDB — ID cards and backups will now persist permanently.
   If instead you see a connection error, double-check the
   username/password and that Network Access allows 0.0.0.0/0.

8. Confirm it worked: open https://<your-service-url>/healthz — it
   should show "storage": "mongodb". Publish a test ID card from the
   app, wait a few minutes, and check the health check again; the
   idcards count should stay the same (nothing was lost).

Without MONGODB_URI set, the server still runs fine using a local
file — useful for quick local testing — but you'll see a loud
warning in the logs every time it starts, and data will not survive
a restart.

------------------------------------------------------------
CONNECTING BEAT SMS TO YOUR DEPLOYED SERVICE
------------------------------------------------------------
Once deployed, open BEAT SMS → log in as a school → Settings →
"🌐 Cloud ID Card Hosting" → paste your service URL (e.g.
https://beat-sms-service.onrender.com) → Save → "Test connection"
to confirm it's reachable. From then on:
  - Opening any student/staff Digital ID card automatically
    publishes/updates its cloud copy, and the QR code on the card
    switches to the live verification link.
  - "☁️ Backup to cloud now" / "⬇️ Restore latest from cloud" in the
    same Settings panel back up and restore that school's full data,
    keyed by its own license key — one school's data never overwrites
    another's.

------------------------------------------------------------
ELIMINATING COLD-START DELAYS (recommended for a paying product)
------------------------------------------------------------
Once MONGODB_URI is set, your data is safe forever — but Render's
free web service tier still spins down after 15 minutes with no
traffic, taking 30-60 seconds to wake up on the next request.
Either:
  (a) Upgrade to Render's paid "Starter" instance (~$7/month) to
      remove spin-down entirely, or
  (b) Stay free and use a free monitor (e.g. https://uptimerobot.com
      or https://cron-job.org) to ping /healthz every 5-10 minutes,
      which keeps the service awake most of the time at no cost.

Either way, your DATA is safe once MONGODB_URI is set — these two
options are purely about response speed, not data loss.

------------------------------------------------------------
OPTION B — RAILWAY.APP or FLY.IO
------------------------------------------------------------
Both work the same way: point them at this folder (or its own
GitHub repo), Node runtime, "npm install" / "npm start", and set
MONGODB_URI as an environment variable.
