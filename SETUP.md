# SETUP — From Zero to Live

Follow this top to bottom, in order. Each step says what you're doing and
why. Anywhere you see a command in a grey box, you type (or copy-paste)
that exactly into a terminal — **which terminal** depends on which path
below fits your situation.

If you get stuck partway through, it's safe to stop and come back —
nothing here is destructive, and every step can be re-run without harm.

---

## Which path should I use?

All three end up in exactly the same place — a live, working app. Pick
based on what device you're setting this up from.

**Path A — Google Cloud Shell.** *Recommended if you have a phone or
tablet only, or just want the simplest option.* A real, full Linux
terminal that runs entirely in your browser — nothing to install, no
laptop needed. Go to
[shell.cloud.google.com](https://shell.cloud.google.com), sign in with
the same Google account as your Firebase project, and every command in
this guide (Steps 0, 4, 5, 6) works exactly as written, typed straight
into that browser terminal. It remembers your files between sessions.
Upload this project's files to it first (there's an upload button in the
Cloud Shell toolbar — upload the whole unzipped folder, or upload the zip
and run `unzip` once you're in there).

**Path B — GitHub Actions.** *Zero terminal, ever — everything happens
by clicking buttons on the GitHub website or app.* More setup up front
(you're creating a small robot account for GitHub to deploy with), but
after that, deploying or granting someone access is just filling in a
form on github.com. See the box at Steps 4–6 below for exactly what
replaces the terminal commands. Good if you'd rather never see a command
line again after today.

**Path C — Termux on your Pixel.** A real terminal app, installed
natively on your phone (Google Play or F-Droid). Works fully offline for
editing, needs internet for the actual deploy steps. Good if you want a
persistent setup that lives on your phone itself rather than in a
browser tab. Once installed, run `pkg install nodejs git` inside it, then
every command in this guide works the same as on a laptop.

**Path D — a laptop/desktop, the traditional way.** If you get access to
one later, everything below works exactly as written in its normal
terminal app (Terminal on Mac, Command Prompt/PowerShell on Windows,
Terminal on Linux).

The rest of this guide is written for Path A/C/D (an actual terminal,
wherever it's running). Path B replaces the terminal-based steps with
GitHub website steps — those are called out explicitly where they differ.

---

## Step 0 — Install the tools (one-time, on your computer)

*(Path A: skip this — Cloud Shell already has everything. Path B: skip
this entirely, see the Path B box at Step 4. Path C: run `pkg install
nodejs git` inside Termux instead of the two steps below.)*

You need two things installed once:

1. **Node.js** — download and install from [nodejs.org](https://nodejs.org)
   (choose the "LTS" version). This lets your computer run the Firebase
   tools and the setup scripts.
2. **Firebase CLI** — once Node is installed, open a terminal and run:
   ```
   npm install -g firebase-tools
   ```

Then log in to your Google account from the terminal:
```
firebase login
```
This opens a browser window — sign in with the Google account that owns
(or will own) your Firebase project.

*(Path A note: Cloud Shell has Node and can install firebase-tools the
same way, but `firebase login` works slightly differently in a
browser-only environment — it'll print a URL to open and a code to paste
back in, rather than opening a window itself. Just follow what it prints.)*

---

## Step 1 — Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project**, name it (this codebase assumes the project ID
   `cohi-survey-engine` — if you pick a different ID, update it in
   `.firebaserc` and in `js/core-firebase.js` to match)
3. Once created, you'll land on the project's dashboard

### Turn on the services this app needs
Still in the Firebase console, for this project:

- **Build → Firestore Database** → Create database → choose a location
  close to the UK (e.g. `europe-west2` / London) → start in production
  mode (the security rules in this codebase handle access control, you
  don't need Firestore's default test-mode rules)
- **Build → Storage** → Get started → same region as above
- **Build → Authentication** → Get started → enable the **Email/Password**
  sign-in method (this is what real staff logins use now)
- **Build → Functions** → you'll be prompted to upgrade to the **Blaze
  (pay as you go) plan** — this is required for Cloud Functions to run at
  all. See `PLAN.md` for the real cost breakdown at your survey volume
  (short version: effectively £0–10/month)

---

## Step 2 — Enable the Google Maps APIs

This is a separate console from Firebase — Google Cloud Console, since
Maps is a different product family.

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Make sure the project selector (top left) shows the **same project**
   you just created in Firebase — Firebase projects are Google Cloud
   projects under the hood, so it'll already be there
3. Go to **APIs & Services → Library**
4. Search for and **Enable** each of:
   - **Street View Static API**
   - **Maps Static API**
5. Go to **APIs & Services → Credentials → Create Credentials → API key**
   — this is your `GOOGLE_MAPS_API_KEY` for the next step
6. You'll also need billing enabled on this Google Cloud project (**Billing**
   in the left sidebar → link a payment method) — this is the "card on
   file" mentioned in `PLAN.md`; real spend at 150 surveys/month is £0

---

## Step 3 — Get every other API key

Open `functions/.env.secrets` in this project — it's the one document
where every key gets pasted. Each line has a comment telling you exactly
where to get that specific key (Ordnance Survey, EPC Register, Gemini,
etc). Go through it top to bottom and fill in every value you can get
right now — leave `RILLA_WEBHOOK_SECRET` blank until Rilla's team confirms
their side (see `PLAN.md`).

---

## Step 4 — Push all the keys to Firebase in one go

*(Path A/C/D — using a terminal, wherever it's running.)*

Once `functions/.env.secrets` is filled in, from the project root run:

```
./scripts/push-secrets.sh
```

This reads that one file and uploads every key to Firebase's secure
Secret Manager automatically — you don't need to run any of the
individual `firebase functions:secrets:set` commands yourself. It's safe
to re-run this any time you change a key later.

---

### Path B (GitHub Actions) — Steps 4, 5 and 6 replaced entirely

If you're using Path B, **skip Steps 4, 5, and 6 below and do this
instead.** This is a one-time setup; after it's done, every future deploy
is just clicking "Run workflow" on the GitHub website.

**1. Create a deploy robot account (Google Cloud Console, in your
browser):**
- Go to [console.cloud.google.com](https://console.cloud.google.com) →
  make sure your Firebase project is selected → **IAM & Admin → Service
  Accounts → Create Service Account**
- Name it something like `github-deployer`, click through the creation
  steps
- On the "Grant this service account access" step, add the role
  **Editor** (simplest option that will definitely work — you can
  tighten this later if you want)
- Once created, click on it → **Keys tab → Add Key → Create new key →
  JSON** — this downloads a `.json` file to your device. This file is a
  credential, treat it like a password.

**2. Push your project to GitHub**, if it isn't already — on
[github.com](https://github.com), create a new repository, then use the
"Add file → Upload files" button to drag in this whole project folder
(everything except the `functions/.env.secrets` file itself — that one
should never be uploaded anywhere, GitHub included).

**3. Add your secrets to GitHub** (all through the website, no
terminal): in your repository → **Settings → Secrets and variables →
Actions → New repository secret**. Create one secret for each of:
- `GCP_SA_KEY` — paste the **entire contents** of the JSON file from
  step 1
- `OS_API_KEY`, `EPC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_MAPS_API_KEY`,
  `ADMIN_BOOTSTRAP_SECRET` — one secret each, values from
  `functions/.env.secrets`
- `RILLA_WEBHOOK_SECRET` — optional, add later once Rilla confirms their
  side

**4. Deploy:** repository → **Actions tab → "Deploy The Vault" → Run
workflow** button. Watch it run — green tick means it deployed
successfully. From now on, this also runs automatically any time you
edit a file on github.com and commit the change.

**5. Create your first admin login:** first, create your account in
Firebase Authentication (see Step 6 below — that part still needs the
Firebase console, which works fine in a phone browser). Then: repository
→ **Actions tab → "Grant Staff Access" → Run workflow**, fill in your
email and choose "admin", click Run.

Once Path B is set up, skip straight to **Step 7 — Verify it's actually
working** below.

---

## Step 5 — Install dependencies and deploy

*(Path A/C/D only — Path B does this automatically via the workflow.)*

```
cd functions
npm install
cd ..
firebase deploy --only functions,firestore:rules,storage:rules,hosting
```

This uploads your backend code (Cloud Functions), your security rules,
and your website files, all in one command. The first deploy can take a
few minutes.

---

## Step 6 — Create your first admin login

*(Path A/C/D — Path B users did this already at the end of the Path B
box above, using the "Grant Staff Access" workflow instead of step 2
below.)*

Before this step, real Firebase Auth accounts don't exist yet, so nobody
can log into the dashboard.

1. In the Firebase console → **Authentication → Users → Add user** →
   enter your own email and a password
2. Back in your terminal, from the project root:
   ```
   node scripts/bootstrapStaffAccount.js you@yourcompany.com admin YOUR_ADMIN_BOOTSTRAP_SECRET
   ```
   (use the same email as step 1, and whatever you set
   `ADMIN_BOOTSTRAP_SECRET` to in `functions/.env.secrets`)
3. You can now log into the dashboard (`index.html`, wherever Firebase
   Hosting is serving it — check the Firebase console's Hosting section
   for the live URL) with that email and password

For every other member of staff after this: once you're logged in as
admin, use the **Staff Access** screen in the dashboard instead of the
bootstrap script — create their Firebase Auth account in the console
(step 1 above), then grant them access from that screen.

---

## Step 7 — Verify it's actually working

Quick checklist, roughly in the order you'd naturally hit each thing:

- [ ] Log into the dashboard with your admin account
- [ ] Complete a test survey end to end
- [ ] Open **Site Intel** for that survey — postcode data, elevation, EPC
      info should all populate with real data
- [ ] Open **Project Gatekeeper** for it, set a test price, try the PIN
      lockout by entering the wrong PIN 5 times on the vault link
- [ ] Flip **Grant Full Access** and confirm the price appears on the
      customer-facing vault link
- [ ] Send a message in the vault's chat and confirm it appears in
      Gatekeeper's Live Chat panel, and vice versa
- [ ] Try **Dossier Compiler** and confirm a PDF generates with a real
      cover page, real postcode data, and Street View / aerial imagery
- [ ] Click **I'm Ready — Notify My Designer** in the vault and confirm
      the notification lands

If any of those don't work, the error message in the browser console
(right-click → Inspect → Console tab) almost always says which secret or
permission is missing — that's usually enough to point back to the
relevant step above.
