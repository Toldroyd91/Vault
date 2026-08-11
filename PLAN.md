# The Vault — Rebuild Plan & Lead Dev Notes

## How to read this document
This is the running record of what was found, what's been fixed, and what's
left. Treat it as the source of truth for where the project stands — update
it as later phases land.

---

## Phase 0 — Audit findings

The bones of this app are genuinely good: the brand system across all 6
companies, the on-site survey with the postcode/EPC enrichment idea, and the
canvas-based sniper annotation tool are all solid, sensible product
decisions. The problems were entirely in the wiring between pieces, likely
from a refactor that got abandoned halfway:

1. **No real login on the staff dashboard.** `index.html`'s auth gate
   accepted any typed email with no password check at all — full CRM and
   pricing access for anyone with the URL. **Fixed** — see Phase 1.
2. **The price wasn't actually protected.** `vault.html` fetched the entire
   survey record (including price) to the browser before checking the PIN.
   The PIN screen was cosmetic, not a security boundary. **Fixed.**
3. **The dashboard and the vault were talking to different fields.**
   Staff tools wrote price/access-level to `uDesignData` / `vaultAccessLevel`;
   the live vault read a disconnected field called `quoteData` that nothing
   else wrote to. Flipping the switch did nothing for the customer. **Fixed.**
4. **A hardcoded email backdoor** in an orphaned file granted dashboard
   access regardless of real permissions. **Removed** (the file itself was
   dead code, see #6).
5. **Three competing, half-finished PDF engines**, one of which (the
   Puppeteer pipeline) typed a PIN into a text box that no longer existed
   in the markup — silently broken. **Consolidated to one.**
6. **Roughly half of `/js/` was dead code** (`core-state.js`,
   `ui-dashboard.js`, `ui-survey.js`, `ui-vault.js`, `engine-pdf.js`,
   `engine-sniper.js`) — an abandoned modularization attempt that no page
   actually imported. The real app lives entirely in inline
   `<script type="module">` blocks per page. **Deleted**, since nothing
   referenced them.
7. **No Firestore/Storage security rules existed in the repo at all** —
   whatever was enforced only lived in the Firebase console, unversioned
   and unreviewable. **Added.**
8. **The Gemini integration was dead.** `@google/generative-ai` (the old
   Node SDK) and the `gemini-pro` model are both retired. **Fixed.**

---

## Phase 1 — Security & data integrity (DONE)

**Preserved untouched, as instructed:**
- All survey question content in `survey.html`
- The canvas-based sniper/annotation tool (also in `survey.html` — not
  `engine-sniper.js`, which was dead code)

**New data model:**
```
surveys/{id}                    PRIVATE — staff only (custom claim
                                 role: 'designer' or 'admin')
  customerProfile: { leadName, postcode, houseNumber, vaultPIN,
                      apptDate, revisitDate }
  projectSpecs / designerInsights / media / clientUploads
  uDesignData: { renders: [], totalPrice, deposit }
  vaultAccessLevel: 'survey_only' | 'design_tease' | 'full_access'
  designerProfile / designerEmail / pipelineStatus / vaultTelemetry

vaultStatus/{id}                PUBLIC READ — auto-mirrored, price-free
                                 copy. Lets the customer's vault notice
                                 "the switch flipped" live, without ever
                                 holding price data before it's authorized.
                                 Written only by a Cloud Function.

surveys/{id}/messages           Two-way chat. Kept publicly readable/
                                 writable (low sensitivity), same as before.
```

**Cloud Functions (`functions/index.js`, fully rewritten):**
- `verifyVaultPin` — the real price gate. Checks the PIN server-side and
  only includes price fields in the response when `vaultAccessLevel ===
  'full_access'`. An incorrect PIN, or a correct PIN before the designer
  has flipped the switch, means price never reaches the browser at all.
- `mirrorVaultStatus` — Firestore trigger keeping `vaultStatus/{id}` in
  sync so the live "flick the switch" moment works during the second
  appointment.
- `getSystemRenderData` + rewritten `compilePDF` — the PDF pipeline now
  mints a short-lived, single-purpose render token instead of trying to
  type the customer's PIN into the page.
- `addClientUpload`, `syncVaultTelemetry` — moved server-side now that
  `surveys/{id}` is locked down to staff.
- `grantStaffRole` — replaces the hardcoded email; grants the `designer`/
  `admin` custom claim. See `scripts/bootstrapStaffAccount.js` for the
  one-time first-admin setup.
- `rewriteNotes` — migrated off the retired `@google/generative-ai` SDK
  and `gemini-pro` model to `@google/genai` + `gemini-2.5-flash`.

**Rules:** `firestore.rules` and `storage.rules` added and wired into
`firebase.json` — this was previously entirely unmanaged.

**Frontend:**
- `index.html` — real Firebase Authentication (email + password, custom
  claim check), a working logout button, brand theming kept as a
  post-login cosmetic step only.
- `vault.html` — now calls `verifyVaultPin` instead of reading Firestore
  directly, reads the fields the dashboard actually writes, and reflects
  a live access-level change without a page reload.

## Action required before this goes live

**Full step-by-step instructions now live in `SETUP.md`** — from creating
the Firebase project through to your first working login. Keeping one
copy of this checklist rather than two, since a second copy is exactly
the kind of thing that quietly drifts out of sync (see the several "two
disconnected versions of the same field" bugs found earlier in this
document).

Short version: fill in `functions/.env.secrets` (one file, every key,
each with a comment on where to get it), run `./scripts/push-secrets.sh`
to upload them all in one go, then follow `SETUP.md` from Step 5 onward
for install/deploy/first-login.

---

## Phase 2 — Dashboard & pipeline audit (DONE)

Auditing "does this field exist on both ends" across every price-entry
surface turned up more of the same disease as the vault bug in Phase 1 —
each one now fixed:

1. **`index.html`'s embedded PDF-scraper ("Project Gatekeeper" module)**
   wrote extracted prices to a dead `quoteData` field and never set
   `vaultAccessLevel` at all — meaning a price extracted this way would
   have gone live to the customer immediately, with no second-appointment
   gate whatsoever. Now writes `uDesignData.totalPrice/deposit` +
   `vaultAccessLevel: 'design_tease'`, and also extracts the deposit line
   (previously only the total was extracted).
2. **`quotes.html`'s U-Design PDF importer** wrote to yet another
   different field, `uDesignQuote` — nothing else in the app ever read
   it, so a quote pushed from this screen never reached the customer at
   all. Now uses the same `uDesignData` schema as everything else.
3. **Project Library cards and the Gatekeeper pipeline list** in
   `index.html` both checked the same dead `quoteData` field for their
   "Vault Ready" / "Quote Unlocked" badges — always showing "not ready"
   regardless of actual state. Fixed.
4. **Admins couldn't see projects assigned to other designers** — the
   project list and gatekeeper list filtered strictly by
   `designerEmail === currentUserEmail`, with no exception for the admin
   role. Fixed.
5. **`pdf-compiler.html` hardcoded "Yorkshire Windows"** in five places
   (cover title, filename, fallback designer-team name, review copy) —
   every survey from your other 5 brands would have generated a
   Yorkshire Windows–branded dossier. Now pulls the real brand from the
   survey record via the existing (and already-correct) `BRAND_CONFIG`.

**New: Admin "Staff Access" screen** — an admin-only nav item and panel
wrapping `grantStaffRole`, so granting a colleague dashboard access is now
a form in the UI instead of a manual console/script step. (It still
assumes the person's Firebase Auth *account* already exists — creating
new accounts outright would need an email/password-setup flow, which felt
like a reasonable v2 rather than blocking this on it.)

### Found but NOT yet fixed — flagging clearly rather than quietly building on top of it
`pdf-compiler.html`'s postcode intelligence section (wind load, snow load,
flood risk, conservation area status, EPC band, planning precedent) is
**entirely fabricated placeholder text**, not real data — despite the
on-screen console in `index.html`'s Dossier Compiler literally telling
your staff it's "Querying UK Govt EPC Database" and "Triangulating
Open-Meteo structural snow loads" while it happens. The real EPC/OS Maps
Cloud Functions already exist and work (`fetchEPCData`, `fetchOSMap`) —
they're just not wired into the dossier yet. Worth prioritizing, since as
it stands a designer could unknowingly repeat a fabricated flood-risk or
EPC figure to a customer as fact. This is Phase 4 work; flagging it now
because of the trust/liability angle, not because it's a coding
afterthought.

Still outstanding from the original Phase 2 scope:
- Replace remaining `localStorage`-based state with Firestore-backed state
  where it affects more than one device (e.g. so a survey started on a
  tablet, half-finished, is resumable)
- `index.html` (SPA with internal modules) and the standalone pages
  (`admin-gatekeeper.html`, `quotes.html`, `pdf-compiler.html`) are two
  different UI paradigms with separate, disconnected navigation, and
  `admin-gatekeeper.html` overlaps significantly with `index.html`'s own
  "Project Gatekeeper" module — same job, two different tools. Worth
  deciding which one to keep as canonical in Phase 3 rather than
  maintaining both.

## Phase 3 — Vault presentation layer
- Rebuild `vault.html`'s visual layer (kept functionally intact for now)
  to match the "make it feel £1m" ambition — currently reused as-is
- Bring the design-collaboration flow (Phase 3 of your original brief) up
  to the same data-contract standard as the rest

## Phase 4 — Real postcode intelligence engine (DONE — this pass)

Replaced the entirely fabricated postcode intel block with a new
`getPostcodeIntel` Cloud Function pulling from real, free UK data sources:

- **postcodes.io** — geocoding, local authority, ward, region (free, no key)
- **EPC Open Data** (existing `EPC_API_KEY`) — now surfaces the full real
  record: current/potential rating, floor area, construction age band,
  wall/roof construction — not just the headline band
- **Environment Agency flood-monitoring API** — real *active* flood
  warnings/alerts within 5km (free, no key). Labelled clearly as live
  warning data, not a long-term flood-zone rating — see "not included"
  below for why
- **HM Land Registry Price Paid** (linked-data API, free, no key) — real
  recent sold prices on the postcode, genuine local market credibility

Also added `getStreetViewImage` and `getAerialImage` — real Google Street
View and satellite imagery for the property, dropped straight into a new
dossier page. **These need a `GOOGLE_MAPS_API_KEY`** (Street View Static
API + Maps Static API enabled, billing account attached — both are
inexpensive per-call but not free) — added to the setup checklist above.

**Deliberately NOT faked**, and removed rather than replaced with a
different guess:
- Structural wind/snow load (kN/m²) — a real Eurocode calculation needs
  altitude, terrain category and distance-to-sea, which none of the above
  sources provide. A free/reliable source for this hasn't been found yet.
- Conservation area / listed building status — no verified free API wired
  in. Historic England publish open data for this; worth adding once
  confirmed.

Every field in the new dossier page says "Not available" rather than a
plausible-looking number when a source has nothing for that postcode —
this matters because a designer could otherwise unknowingly repeat a
fabricated figure to a customer as fact.

### Still open from the original Phase 4 scope
- Decide whether `pdf-compiler.html` (staff-only, no price exposure risk)
  stays as a manual "compile" button or gets folded into a fully automated
  pipeline that fires the moment a survey is marked complete
- Property boundary polygons (Land Registry INSPIRE Index Polygons / OS
  NGD) — real data exists but needs a paid OS NGD tier or a separate
  ingestion pipeline; not wired in yet
- Historic England listed building / conservation area status

---

## Phase 5 — Tool consolidation & a genuinely severe find (DONE — this pass)

Went looking at the "two Gatekeeper tools" duplication flagged at the end
of Phase 2. Found more than expected:

1. **The price fields in `admin-gatekeeper.html` had hardcoded demo
   values baked in as real defaults** (`value="19724.00"`,
   `value="2959.00"`) — not placeholder text, actual pre-filled values. If
   a designer opened this page and clicked "Lock In" without noticing,
   that fake number would have gone to a real customer. This is the most
   severe individual bug found across the whole audit so far — worse than
   a crash, because it fails silently and confidently. Fixed: real
   placeholder text only, and the fields now populate from the actual
   current price on the document so staff see real state, not a blank or
   fake number.
2. **`admin-gatekeeper.html` is now the one canonical pricing/access
   tool.** It already had the important piece nothing else did — the
   actual `vaultAccessLevel` switch — so rather than pick a different
   winner, the other two were folded into it:
   - `index.html`'s embedded "Project Gatekeeper (PDF Scraper)" module
     lost its own write path entirely and is now just a launcher into
     `admin-gatekeeper.html?id={id}` for the selected project.
   - `quotes.html` is now a deprecation redirect page (kept, so old
     bookmarks don't 404) pointing to the same tool.
   - The PDF auto-fill capability from both (including the U-Design
     "GRAND TOTAL" format) was merged into a single "Auto-fill from Quote
     PDF" control in `admin-gatekeeper.html` — it only fills the fields,
     it never saves on its own, so there's one clear save action left in
     the whole app instead of three.
3. **`property-intel.html` was saved to disk as `property-intel` with no
   extension** — its own nav link, and the link to it from
   `admin-gatekeeper.html`'s sidebar, had been silently 404ing since it
   was written. Once opened, this turned out to be a genuinely well-built,
   already-real feature (postcodes.io, Open-Meteo elevation data,
   sunrise-sunset.org for glazing recommendations, plus the existing real
   EPC/OS Cloud Functions) that nobody could ever have actually reached.
   Fixed the filename and added it to the main dashboard nav as "Site
   Intel" so it's finally reachable.
4. While in there: its "Financial Baseline" card was badged **"HMLR
   Algo"** but was actually just floor-area × a hardcoded £2,600/sqm
   constant — not Land Registry data at all despite the badge implying it
   was. Replaced with genuine Land Registry Price Paid sold-price data via
   the `getPostcodeIntel` function built in Phase 4. Also toned down a
   couple of "bypassing firewalls/security protocols" loading messages
   that would look bad if a customer glimpsed the screen over a
   designer's shoulder.

---

## Phase 6 — A separate legacy backend nobody remembered (DONE — this pass, but action needed from you)

`portal.html` and `signup.html` turned out to point at a **completely
different Firebase project** (`cohi-live`) than the rest of the app
(`cohi-survey-engine`) — same API key hardcoded in both, both clearly
copy-pasted from a "*** PASTE YOUR FIREBASE CONFIG HERE ***" tutorial
template early on and then forgotten about.

- **`portal.html`** was an earlier prototype of the vault, reading from a
  `quotes` collection nothing else in the app uses, with the exact same
  price-exposure flaw the real vault had before Phase 1 — full price
  fetched to the browser before checking `isUnlocked`. **Retired** — it's
  not linked from anywhere in this app, and its job is already done
  properly by the real vault.
- **`signup.html`** was worse: real, working self-service registration
  that **auto-granted a `role: "designer"` field on account creation,
  with no approval step at all.** Fixed and repointed at your real
  project — creating an account now only requests access (recorded in a
  new `accessRequests` collection); an admin has to actively grant it from
  the Staff Access screen, which now shows pending requests with one-click
  grant/dismiss.

### ⚠️ This needs you to check something I can't check from here
I have no credentials or network access to the `cohi-live` project itself.
**Please check, in the Firebase console, whether that project still
exists and is still active.** If it is:
- Check whether it holds any real customer data in a `quotes` or
  `designers` collection
- Check its Firestore security rules — if they're permissive (or absent),
  the vulnerability in the old `portal.html` may still be live wherever
  that project is actually hosted, independent of anything fixed in this
  repository
- If it's genuinely dead and unused, consider deleting the project
  outright to remove the exposure entirely

Fixing the copies of these files in this repo doesn't retroactively secure
a different, separately-hosted project — this is the one finding in this
whole audit that needs a step from you outside of code.

---

## Phase 7 — Missing showpiece, real analytics, live chat, brand switching, Rilla (DONE — this pass)

1. **The actual 3D design renders had no display surface in the vault.**
   Designers upload them via Project Gatekeeper, they were sent to the
   browser via `verifyVaultPin`, and then never shown anywhere. This was
   the single biggest gap between "what's built" and "£1m feel" — fixed,
   now the lead section of the vault.
2. **Real vault analytics**, replacing counters that were tracked
   client-side and silently discarded every heartbeat:
   - Total time in vault, last active, quote-revealed status, photos
     viewed — now actually persisted
   - **Per-design engagement tracking** (IntersectionObserver-based) shows
     exactly which render a customer keeps coming back to, surfaced as a
     ranked bar chart in Project Gatekeeper
3. **Live chat**, built from scratch — it never existed in the live app,
   only in dead code removed weeks ago. Customer-facing chat in the vault,
   designer-facing reply panel in Project Gatekeeper, live unread-message
   badges on the pipeline list so staff don't need to keep every project
   open to know a customer wrote in.
4. **PDF watermark** — subtle diagonal brand watermark on every dossier
   page except full-bleed cover/pamphlet pages.
5. **Pamphlet safety fix** — several pamphlet pages reference artwork that
   doesn't exist yet in `assets/shared/` (see checklist below); these used
   to render a debug "IMAGE ASSET MISSING" placeholder in a client-facing
   document. Now they silently skip instead.
6. **Real compliance/guarantee page**, sourced from CO Home Improvements'
   actual published brand facts (20 year guarantee, Conservatory Outlet
   Premium Retailer status) plus the FCA credit-broker disclosure your
   quotes are legally required to carry given finance is offered.
7. **Rilla webhook receiver** — built and ready, but genuinely can't be
   finished without Rilla's team confirming their exact payload format and
   matching key (see checklist below); this isn't a "coming soon", it's a
   real external dependency.
8. **Designer brand cross-switching** — didn't exist at all; a designer's
   theme was permanently guessed from their email domain with no way to
   change it, which directly contradicted "we work across multiple brands
   and don't shy away from it." Added a "Working As" switcher in the
   sidebar, saved per-designer.
9. **Found while building #8: the `designers` collection had no Firestore
   rule at all**, meaning the Designer Profile module has been silently
   permission-denied under the staff-only lockdown from Phase 1 the entire
   time. Fixed.
10. **Removed a second, slightly different hardcoded copy of all 6 brand
    colours** that had drifted from the canonical `BRAND_CONFIG` — one
    source of truth now, colours derived from hex rather than hand-kept
    hex+rgb pairs.

### Missing pamphlet artwork — needs you to supply these
`assets/shared/` is missing: `journey.jpg`, `piling.jpg`, `tailored.jpg`,
`planning.jpg`, `sap-calcs.jpg`, `protecting-home.jpg`. Full-bleed A4
(2480×3508px @ 300dpi recommended). Until supplied, those pamphlet pages
are simply omitted from the dossier rather than shown broken.

### Rilla — what's needed from their team before this can go live
- Exact JSON payload shape (field names for recording URL, transcript, AI
  summary, appointment time, rep name)
- A matching key we can tie back to our own project — ideally we pass our
  `surveyId` to Rilla when booking, and they echo it back
- Their outbound webhook authentication method (shared secret header is
  typical — `RILLA_WEBHOOK_SECRET` is scaffolded for this)

---

## Phase 8 — Closing the loop: e-signature + PIN security (DONE — this pass)

1. **PIN brute-force protection.** `verifyVaultPin` had no rate limiting
   at all — a 4-digit PIN is only 10,000 combinations, trivially
   guessable with no throttling behind it. Now locks out for 15 minutes
   after 5 failed attempts, resets on success, and the vault surfaces the
   actual lockout message to the customer rather than a generic error.
2. **"Ready to Proceed" signal** (revised from an initial e-signature
   design). The vault could present a price beautifully but had no way
   for a customer to say "I'm interested" — but a proper e-signature
   would have created a second, differently-worded record of acceptance
   running alongside your existing contract-signing and payment
   processes, which risks conflicting with the real contract rather than
   helping. This is deliberately lighter: one button, no name captured,
   no legal framing anywhere in the UI or the data — it just notifies the
   designer that the customer is ready, the same way an unread chat
   message does, and your existing process takes it from there.

### Recommended next, not yet built — needs your input first
- **Post-sale milestone tracker** in the vault (matching whatever stages
  your existing contract/payment process actually has — Signed → Deposit
  Paid → Installation Scheduled → Complete, or your real equivalents) —
  most competitors go quiet after the sale; this keeps the "we're there
  for you" feeling through the whole job
- **Automated review/referral request** triggered when a project hits
  "Complete"
- **Auto-drafted follow-up email** (reusing the existing Gemini
  integration) sent automatically after a survey — needs an email-sending
  service decision (SendGrid, Postmark, etc.)

---

## Phase 9 — Unified setup + a critical secret-binding bug (DONE — this pass)

1. **Found while building the setup docs: none of the Cloud Functions
   actually declared which secrets they needed.** Firebase Functions v2
   requires each function to explicitly list `secrets: ["KEY_NAME"]` in
   its options — without that, `process.env.KEY_NAME` stays `undefined`
   at runtime even after correctly setting the secret via the Firebase
   CLI. Every API-key-dependent feature (postcode intel, EPC lookups,
   Street View/aerial imagery, the Gemini notes rewriter, admin bootstrap,
   the Rilla webhook) would have silently failed with this bug in place —
   fixed across all 8 affected functions.
2. **One unified document for every API key** — `functions/.env.secrets`.
   Every key the app needs, in one file, each with a comment on exactly
   where to get it. Never committed (in `.gitignore`), never read by the
   live app itself — it only exists locally as the staging area before
   keys go into Firebase's real secret storage.
3. **`scripts/push-secrets.sh`** — reads that one file and uploads every
   key to Firebase Secret Manager automatically, instead of running each
   `firebase functions:secrets:set` command by hand. Safe to re-run any
   time a key changes; skips blank lines so partial setup is fine.
4. **`SETUP.md`** — a complete, linear, non-developer-oriented walkthrough
   from installing Node.js through to a verified working login, replacing
   the checklist that used to live in this document (kept here only as a
   pointer now, so there's one source of truth instead of two that could
   drift apart).
5. Added `.firebaserc` (pre-filled with the project ID already used
   throughout the codebase) and `.gitignore` — neither existed before.
6. **Three phone/terminal-free deployment paths added to `SETUP.md`**,
   since real terminal access isn't a given: Google Cloud Shell (a full
   Linux terminal in the browser, no install), GitHub Actions
   (`.github/workflows/deploy.yml` + `grant-access.yml` — zero terminal
   ever, deploys and staff-access grants become buttons on the GitHub
   website), and Termux (a native terminal app for Android). All three
   run the exact same underlying commands as a laptop would.

---

## Known constraints while working with me on this

- I can't `npm install`, deploy to Firebase, or hit the live project from
  this sandbox — no network access here. Everything above is
  syntax-checked but not integration-tested against your real project. Run
  it in a staging environment before pointing it at real customers.
- Given the size of this codebase, I'm working through it in the phases
  above rather than rewriting everything at once — flag anything urgent
  and I'll reprioritize.
