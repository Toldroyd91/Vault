const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { GoogleGenAI } = require("@google/genai");
const puppeteer = require("puppeteer");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// ==========================================================================
// DATA CONTRACT (read this before touching any field name in this file)
// ==========================================================================
// surveys/{id}            <- PRIVATE. Full record. Staff (custom claim role
//                             "designer" or "admin") only. Never readable by
//                             an unauthenticated client.
//   customerProfile: { leadName, postcode, houseNumber, vaultPIN, apptDate, revisitDate }
//   projectSpecs / designerInsights / logistics / media / clientUploads
//   uDesignData: { renders: [], totalPrice, deposit }
//   vaultAccessLevel: 'survey_only' | 'design_tease' | 'full_access'
//   designerProfile / designerEmail / pipelineStatus / vaultTelemetry
//   systemRenderToken / systemRenderExpiry  <- ephemeral, PDF pipeline only
//
// vaultStatus/{id}        <- PUBLIC READ. Auto-mirrored copy of surveys/{id}
//                             with the PIN and every price field stripped.
//                             Lets the customer's browser know "the switch
//                             flipped" in real time WITHOUT ever receiving
//                             the price itself. Written only by
//                             mirrorVaultStatus below — never by clients.
//
// surveys/{id}/messages   <- Two-way chat. Low sensitivity, kept publicly
//                             readable/writable as before.
// ==========================================================================

function stripUndefined(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// --- 1. AI NOTES ENGINE (fixed: old @google/generative-ai SDK + gemini-pro
//         are both retired) ---
exports.rewriteNotes = onCall({ cors: true, secrets: ["GEMINI_API_KEY"] }, async (request) => {
  const rawText = request.data?.rawText;
  if (!rawText || typeof rawText !== "string") {
    throw new HttpsError("invalid-argument", "rawText is required.");
  }
  const prompt = `Rewrite these rough site-survey notes into a professional, sales-focused architectural description for a CO Home Improvements extension client. Keep it sophisticated and persuasive, and do not invent facts that are not implied by the notes:\n\n${rawText}`;

  const result = await genAI.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
  });

  return { polishedText: result.text };
});

// --- 2. VAULT ACCESS: THE REAL PRICE GATE ---
// The customer's browser NEVER reads surveys/{id} directly. It calls this
// function with the PIN; the function checks it server-side (Admin SDK,
// bypasses all client rules) and returns only the fields the current
// vaultAccessLevel entitles them to. If the PIN is wrong, or the access
// level is below full_access, the price fields are simply never put on
// the wire — there is nothing for a curious customer to find in dev tools.
exports.verifyVaultPin = onCall({ cors: true }, async (request) => {
  const { id, pin } = request.data || {};
  if (!id || !pin) throw new HttpsError("invalid-argument", "id and pin are required.");

  const ref = db.collection("surveys").doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "No project found for this link.");

  const data = snap.data();

  // A 4-digit PIN is only 10,000 combinations — with no throttling that's
  // trivially brute-forceable in minutes. Lock out after 5 failed
  // attempts for 15 minutes, and again after every batch of 5 further
  // attempts, rather than a hard permanent lock (a customer who
  // genuinely mistypes their PIN several times shouldn't need to call
  // support to get back in).
  const attempts = data.pinAttempts || { count: 0, lockedUntil: 0 };
  const now = Date.now();

  if (attempts.lockedUntil && now < attempts.lockedUntil) {
    const minutesLeft = Math.ceil((attempts.lockedUntil - now) / 60000);
    throw new HttpsError("resource-exhausted", `Too many incorrect attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`);
  }

  const storedPin = String(data.customerProfile?.vaultPIN || "").trim();
  if (String(pin).trim() !== storedPin) {
    const newCount = (attempts.lockedUntil && now >= attempts.lockedUntil) ? 1 : attempts.count + 1;
    const update = { pinAttempts: { count: newCount, lockedUntil: 0 } };
    if (newCount >= 5) {
      update.pinAttempts.lockedUntil = now + 15 * 60 * 1000; // 15 minute lockout
    }
    await ref.update(update);
    throw new HttpsError("permission-denied", "Incorrect PIN.");
  }

  // Correct PIN — reset the counter.
  if (attempts.count > 0 || attempts.lockedUntil) {
    await ref.update({ pinAttempts: { count: 0, lockedUntil: 0 } });
  }

  const accessLevel = data.vaultAccessLevel || "survey_only";
  const includePrice = accessLevel === "full_access";

  return stripUndefined({
    brand: data.brand || "YorkshireWindows",
    pipelineStatus: data.pipelineStatus || "1. Consultation",
    vaultAccessLevel: accessLevel,
    customerProfile: {
      leadName: data.customerProfile?.leadName || "Client",
      revisitDate: data.customerProfile?.revisitDate || null,
    },
    projectSpecs: data.projectSpecs || {},
    designerInsights: data.designerInsights || {},
    media: data.media || {},
    designerProfile: data.designerProfile || {},
    designerEmail: data.designerEmail || "sales@yorkshirewindows.com",
    readyToProceed: !!data.readyToProceed,
    uDesignData: {
      renders: data.uDesignData?.renders || [],
      totalPrice: includePrice ? (data.uDesignData?.totalPrice ?? null) : null,
      deposit: includePrice ? (data.uDesignData?.deposit ?? null) : null,
    },
  });
});

// --- 3. TELEMETRY (view-time heartbeat) ---
// Extended to actually persist the engagement data the vault was already
// collecting client-side (accordion opens, photo views) but previously
// threw away every heartbeat, plus per-render view time — this is what
// answers "which design are they spending the most time looking at".
exports.syncVaultTelemetry = onCall({ cors: true }, async (request) => {
  const { id, seconds, hasRevealedQuote, accordionsOpened, photosViewed, renderEngagementSeconds } = request.data || {};
  if (!id) throw new HttpsError("invalid-argument", "id is required.");

  const ref = db.collection("surveys").doc(String(id));

  const update = {
    "vaultTelemetry.lastActive": Date.now(),
    "vaultTelemetry.totalViewTimeSeconds": Number(seconds) || 0,
    "vaultTelemetry.hasRevealedQuote": !!hasRevealedQuote,
    "vaultTelemetry.accordionsOpened": Number(accordionsOpened) || 0,
    "vaultTelemetry.photosViewed": Number(photosViewed) || 0,
  };

  // renderEngagementSeconds looks like {"0": 12.4, "1": 47.1} — merge
  // rather than overwrite, since the vault sends running totals per
  // session and a customer may return across multiple visits.
  // Dot-notation paths only merge correctly with update() (not
  // set(..., {merge:true}), which treats dotted strings as literal field
  // names) — that's why this uses update() rather than set().
  if (renderEngagementSeconds && typeof renderEngagementSeconds === "object") {
    for (const [idx, secs] of Object.entries(renderEngagementSeconds)) {
      update[`vaultTelemetry.renderEngagementSeconds.${idx}`] = admin.firestore.FieldValue.increment(Number(secs) || 0);
    }
  }

  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "No project found for this link.");
  await ref.update(update);
  return { ok: true };
});

// --- 3b. "READY TO PROCEED" SIGNAL ---
// Deliberately NOT an e-signature — the business already has its own
// contract-signing and payment processes, and a second, differently-worded
// "signed" record in this app would risk conflicting with the real
// contract (different price rounding, no actual terms attached, a
// customer thinking a button click was the agreement). This only ever
// records "the customer said they're ready" as a CRM signal for staff to
// act on — no name captured, no legal weight implied anywhere in the UI
// or the data it stores.
exports.confirmReadyToProceed = onCall({ cors: true }, async (request) => {
  const { id, pin } = request.data || {};
  if (!id || !pin) throw new HttpsError("invalid-argument", "id and pin are required.");

  const ref = db.collection("surveys").doc(String(id));
  const readySnap = await ref.get();
  if (!readySnap.exists) throw new HttpsError("not-found", "No project found for this link.");

  const readyData = readySnap.data();
  const readyStoredPin = String(readyData.customerProfile?.vaultPIN || "").trim();
  if (String(pin).trim() !== readyStoredPin) {
    throw new HttpsError("permission-denied", "Incorrect PIN.");
  }

  if ((readyData.vaultAccessLevel || "survey_only") !== "full_access") {
    throw new HttpsError("failed-precondition", "The quote isn't unlocked yet.");
  }

  await ref.update({
    readyToProceed: {
      confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  });

  await ref.collection("messages").add({
    sender: "System",
    role: "Notification",
    text: `The customer has confirmed they're ready to proceed — reach out to arrange next steps.`,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true };
});


// --- 4. CLIENT FILE UPLOADS (moved server-side so surveys/{id} can be
//         locked down to staff-only in Firestore rules) ---
exports.addClientUpload = onCall({ cors: true }, async (request) => {
  const { id, url, name } = request.data || {};
  if (!id || !url || !name) throw new HttpsError("invalid-argument", "id, url and name are required.");

  const ref = db.collection("surveys").doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "No project found for this link.");

  await ref.update({
    clientUploads: admin.firestore.FieldValue.arrayUnion({ url, name, date: new Date().toISOString() }),
    "timestamps.updatedAt": new Date().toISOString(),
  });
  await ref.collection("messages").add({
    sender: "System",
    role: "Notification",
    text: `Client uploaded a new file: ${name}`,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

// --- 5. MIRROR: keeps vaultStatus/{id} (public, price-free) in sync with
//         surveys/{id} (private) any time staff update a lead. This is
//         what lets the vault UI notice "the switch flipped" live during
//         the second appointment without ever holding the price client-side
//         until the customer re-authenticates via verifyVaultPin. ---
exports.mirrorVaultStatus = onDocumentWritten("surveys/{id}", async (event) => {
  const id = event.params.id;
  const after = event.data?.after?.exists ? event.data.after.data() : null;

  if (!after) {
    await db.collection("vaultStatus").doc(id).delete().catch(() => {});
    return;
  }

  await db.collection("vaultStatus").doc(id).set({
    brand: after.brand || "YorkshireWindows",
    pipelineStatus: after.pipelineStatus || "1. Consultation",
    vaultAccessLevel: after.vaultAccessLevel || "survey_only",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
});

// --- 5b. LIVE CHAT: flag unread client messages for staff ---
// The chat thread itself is a plain Firestore subcollection both sides
// write to directly (see firestore.rules) — this trigger just watches for
// new client messages and raises a flag the dashboard can badge, so a
// designer doesn't have to keep a project open to know a customer wrote in.
exports.onNewChatMessage = onDocumentWritten("surveys/{id}/messages/{messageId}", async (event) => {
  const after = event.data?.after?.exists ? event.data.after.data() : null;
  if (!after || event.data?.before?.exists) return; // only care about new messages, not edits

  if (after.role === "Client") {
    await db.collection("surveys").doc(event.params.id).set({
      hasUnreadClientMessage: true,
    }, { merge: true });
  }
});

// --- 6. SECURE SERVER-SIDE RENDER (for the Puppeteer PDF pipeline only).
//         Short-lived, single-purpose token — never the customer's PIN,
//         never reusable after expiry. ---
exports.getSystemRenderData = onCall({ cors: true }, async (request) => {
  const { id, token } = request.data || {};
  if (!id || !token) throw new HttpsError("invalid-argument", "id and token are required.");

  const ref = db.collection("surveys").doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "No project found.");
  const data = snap.data();

  const validToken = data.systemRenderToken;
  const expiry = data.systemRenderExpiry || 0;
  if (!validToken || token !== validToken || Date.now() > expiry) {
    throw new HttpsError("permission-denied", "Render token invalid or expired.");
  }

  // Full, unredacted data — this endpoint is only ever hit by our own
  // Puppeteer instance immediately after compilePDF mints the token below.
  return stripUndefined(data);
});

// --- 7. SERVER-SIDE PDF ENGINE (rewritten) ---
// Old version made Puppeteer literally type the customer's PIN into a text
// box that no longer exists in the current vault.html markup — it was
// silently broken. This version mints a one-time render token instead, so
// there's no dependency on live page markup for auth, and the customer's
// real PIN is never touched by the render pipeline.
exports.compilePDF = onRequest({ memory: "2GiB", timeoutSeconds: 120, cors: true }, async (req, res) => {
  const { surveyId } = req.body.data || {};
  if (!surveyId) return res.status(400).json({ error: "surveyId is required." });

  const ref = db.collection("surveys").doc(surveyId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: "Survey not found." });

  const token = crypto.randomBytes(24).toString("hex");
  await ref.update({
    systemRenderToken: token,
    systemRenderExpiry: Date.now() + 5 * 60 * 1000, // 5 minute single-use window
  });

  let browser;
  try {
    browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.goto(`https://cohi-survey-engine.web.app/vault.html?id=${surveyId}&systemToken=${token}`, {
      waitUntil: "networkidle0",
    });
    await page.waitForSelector("#vaultApp:not(.hidden)", { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1500));

    const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
    await browser.close();

    const bucket = admin.storage().bucket();
    const file = bucket.file(`pdfs/${surveyId}.pdf`);
    await file.save(pdfBuffer, { contentType: "application/pdf" });
    const [url] = await file.getSignedUrl({ action: "read", expires: "03-09-2099" });

    await ref.update({
      "uDesignBridge.quotePdfUrl": url,
      systemRenderToken: admin.firestore.FieldValue.delete(),
      systemRenderExpiry: admin.firestore.FieldValue.delete(),
    });

    res.json({ data: { pdfUrl: url } });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- 8. SECURE ORDNANCE SURVEY PROXY ---
exports.fetchOSMap = onCall({ cors: true, secrets: ["OS_API_KEY"] }, async (request) => {
  const { lat, lng } = request.data || {};
  const osKey = process.env.OS_API_KEY;
  if (!osKey) throw new HttpsError("failed-precondition", "OS API Key missing from server environment.");
  return { url: `https://api.os.uk/maps/raster/v1/zxy/Light_3857/18/${lat}/${lng}.png?key=${osKey}` };
});

// --- 9. SECURE EPC DATABASE PROXY ---
exports.fetchEPCData = onCall({ cors: true, secrets: ["EPC_API_KEY"] }, async (request) => {
  const { postcode, houseNum } = request.data || {};
  const epcKey = process.env.EPC_API_KEY;
  if (!epcKey) throw new HttpsError("failed-precondition", "EPC API Key missing from server environment.");

  try {
    const response = await fetch(`https://epc.opendatacommunities.org/api/v1/domestic/search?postcode=${postcode}`, {
      headers: { Authorization: `Basic ${epcKey}`, Accept: "application/json" },
    });
    if (!response.ok) throw new Error("Failed to authenticate with UK Gov Database");
    const data = await response.json();
    let match = data.rows.find((row) => row.address.toLowerCase().startsWith(String(houseNum || "").toLowerCase()));
    if (!match && data.rows.length > 0) match = data.rows[0];
    return { success: true, data: match || null };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// --- 11. POSTCODE INTELLIGENCE ENGINE ---
// Replaces the fabricated wind-load/snow-load/flood-risk/conservation-area
// block that used to be hardcoded in pdf-compiler.html. Every field here
// comes from a real, free, UK government (or equivalent open) data source.
// Where a source genuinely has nothing for a postcode, we return null and
// say so in the dossier — we do not invent a plausible-looking number.
//
// Sources used (all free, no key unless noted):
//   - postcodes.io                         geocoding + admin areas
//   - EPC Open Data Communities (EPC_API_KEY, already provisioned)
//   - Environment Agency flood-monitoring   ACTIVE flood warnings/alerts
//     within 5km (this is real-time, not a long-term flood-zone rating —
//     labelled accordingly; a proper long-term Flood Zone 1/2/3 lookup
//     needs a commercial data provider and isn't wired in yet)
//   - HM Land Registry Price Paid (linked data, no key)  recent sold
//     prices on the postcode, for genuine local market context
//
// NOT included, and deliberately not faked:
//   - Structural wind/snow load (Eurocode calculations need altitude,
//     terrain category and distance-to-sea inputs we don't have a clean
//     free source for yet — a fabricated kN/m² figure is worse than none)
//   - Conservation area / listed building status (no verified free API
//     wired in yet — Historic England's dataset would be the next thing
//     to add here)
exports.getPostcodeIntel = onCall({ cors: true, secrets: ["EPC_API_KEY"] }, async (request) => {
  const { postcode, houseNum } = request.data || {};
  if (!postcode) throw new HttpsError("invalid-argument", "postcode is required.");

  const result = {
    postcode,
    geo: null,
    epc: null,
    floodWarnings: null,
    recentSales: [],
    errors: [],
  };

  // 1. Geocode + admin areas (postcodes.io — free, no key)
  try {
    const geoRes = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
    const geoJson = await geoRes.json();
    if (geoJson.status === 200 && geoJson.result) {
      const r = geoJson.result;
      result.geo = {
        lat: r.latitude,
        lng: r.longitude,
        adminDistrict: r.admin_district,
        adminWard: r.admin_ward,
        parliamentaryConstituency: r.parliamentary_constituency,
        region: r.region,
        country: r.country,
      };
    }
  } catch (err) {
    result.errors.push("postcodes.io lookup failed: " + err.message);
  }

  // 2. EPC record (reuses the same open dataset as fetchEPCData, but
  //    surfaces the full set of real fields rather than just the rating)
  try {
    const epcKey = process.env.EPC_API_KEY;
    if (epcKey) {
      const epcRes = await fetch(`https://epc.opendatacommunities.org/api/v1/domestic/search?postcode=${encodeURIComponent(postcode)}`, {
        headers: { Authorization: `Basic ${epcKey}`, Accept: "application/json" },
      });
      if (epcRes.ok) {
        const epcJson = await epcRes.json();
        let match = epcJson.rows?.find((row) => row.address.toLowerCase().startsWith(String(houseNum || "").toLowerCase()));
        if (!match && epcJson.rows?.length > 0) match = epcJson.rows[0];
        if (match) {
          result.epc = {
            currentRating: match["current-energy-rating"] || null,
            potentialRating: match["potential-energy-rating"] || null,
            totalFloorArea: match["total-floor-area"] || null,
            constructionAgeBand: match["construction-age-band"] || null,
            wallsDescription: match["walls-description"] || null,
            roofDescription: match["roof-description"] || null,
            windowsDescription: match["windows-description"] || null,
            mainHeatingDescription: match["mainheat-description"] || null,
            propertyType: match["property-type"] || null,
            builtForm: match["built-form"] || null,
            co2EmissionsCurrent: match["co2-emissions-current"] || null,
          };
        }
      }
    }
  } catch (err) {
    result.errors.push("EPC lookup failed: " + err.message);
  }

  // 3. Active flood warnings within 5km (Environment Agency — free, no key)
  // NOTE: this is CURRENT/ACTIVE warning data, not a long-term flood zone
  // classification. Labelled as such wherever it's displayed.
  if (result.geo?.lat && result.geo?.lng) {
    try {
      const floodRes = await fetch(
        `https://environment.data.gov.uk/flood-monitoring/id/floods?lat=${result.geo.lat}&long=${result.geo.lng}&dist=5`
      );
      if (floodRes.ok) {
        const floodJson = await floodRes.json();
        result.floodWarnings = (floodJson.items || []).map((f) => ({
          description: f.description,
          severity: f.severity,
          severityLevel: f.severityLevel,
          riverOrSea: f.floodArea?.riverOrSea || null,
        }));
      }
    } catch (err) {
      result.errors.push("Flood warning lookup failed: " + err.message);
    }
  }

  // 4. Recent sold prices on this postcode (HM Land Registry Price Paid,
  //    linked-data API — free, no key, England & Wales only)
  try {
    const lrRes = await fetch(
      `http://landregistry.data.gov.uk/data/ppi/transaction-record.json?propertyAddress.postcode=${encodeURIComponent(postcode)}&_pageSize=10&_sort=-transactionDate`
    );
    if (lrRes.ok) {
      const lrJson = await lrRes.json();
      const items = lrJson.result?.items || [];
      result.recentSales = items.map((item) => ({
        pricePaid: item.pricePaid,
        date: item.transactionDate,
        propertyType: item.propertyType?.[0]?.label || null,
        newBuild: item.newBuild || false,
        paon: item.propertyAddress?.paon || null,
        street: item.propertyAddress?.street || null,
      }));
    }
  } catch (err) {
    result.errors.push("Land Registry lookup failed: " + err.message);
  }

  return result;
});

// --- 12. STREET-LEVEL & AERIAL IMAGERY ---
// Requires a Google Maps API key with the Street View Static and Maps
// Static APIs enabled — see the "Action required" note in PLAN.md. These
// return image URLs (with the key already embedded) for the dossier to
// drop straight into an <img> tag; they don't proxy the image bytes.
exports.getStreetViewImage = onCall({ cors: true, secrets: ["GOOGLE_MAPS_API_KEY"] }, async (request) => {
  const { lat, lng } = request.data || {};
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new HttpsError("failed-precondition", "GOOGLE_MAPS_API_KEY missing from server environment.");
  if (!lat || !lng) throw new HttpsError("invalid-argument", "lat and lng are required.");

  // Check imagery actually exists here before handing back a URL that
  // might just be Google's grey "no imagery" placeholder.
  const metaRes = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${key}`);
  const meta = await metaRes.json();
  if (meta.status !== "OK") {
    return { available: false };
  }

  return {
    available: true,
    imageUrl: `https://maps.googleapis.com/maps/api/streetview?size=640x640&location=${lat},${lng}&fov=80&key=${key}`,
  };
});

exports.getAerialImage = onCall({ cors: true, secrets: ["GOOGLE_MAPS_API_KEY"] }, async (request) => {
  const { lat, lng } = request.data || {};
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new HttpsError("failed-precondition", "GOOGLE_MAPS_API_KEY missing from server environment.");
  if (!lat || !lng) throw new HttpsError("invalid-argument", "lat and lng are required.");

  return {
    satelliteUrl: `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=19&size=640x640&scale=2&maptype=satellite&key=${key}`,
    roadmapUrl: `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=17&size=640x640&scale=2&maptype=roadmap&key=${key}`,
  };
});

// --- 10. STAFF ACCOUNT BOOTSTRAP ---
// index.html previously had NO real login check at all (any typed email got
// full dashboard + pricing access). Real Firebase Auth is now required, and
// designer/admin access is granted via a custom claim rather than a
// hardcoded email address. Use this once per new starter to grant access:
//   firebase functions:shell
//   > grantStaffRole({ email: "person@yorkshirewindows.com", role: "designer" }, { auth: { token: { role: "admin" } } })
// The very first admin must be bootstrapped with ADMIN_BOOTSTRAP_SECRET
// (set via `firebase functions:secrets:set ADMIN_BOOTSTRAP_SECRET`) since
// no admin custom claim exists yet on a brand new project.
exports.grantStaffRole = onCall({ cors: true, secrets: ["ADMIN_BOOTSTRAP_SECRET"] }, async (request) => {
  const { email, role, bootstrapSecret } = request.data || {};
  if (!email || !["designer", "admin"].includes(role)) {
    throw new HttpsError("invalid-argument", "email and a valid role ('designer' or 'admin') are required.");
  }

  const callerRole = request.auth?.token?.role;
  const isBootstrap = bootstrapSecret && process.env.ADMIN_BOOTSTRAP_SECRET && bootstrapSecret === process.env.ADMIN_BOOTSTRAP_SECRET;

  if (callerRole !== "admin" && !isBootstrap) {
    throw new HttpsError("permission-denied", "Only an existing admin (or the bootstrap secret) can grant staff roles.");
  }

  const user = await admin.auth().getUserByEmail(email);
  await admin.auth().setCustomUserClaims(user.uid, { role });
  return { ok: true, uid: user.uid, role };
});

// --- 13. RILLA APPOINTMENT RECORDING WEBHOOK ---
// Rilla doesn't have one universal public webhook payload — it integrates
// per-CRM (ServiceTitan, HubSpot, Salesforce, Jobber) or via Merge.dev's
// unified API. Since this app isn't one of those, the practical path is:
// Rilla's team sets up a custom outbound webhook pointed at this endpoint.
//
// BEFORE THIS CAN GO LIVE, CONFIRM WITH RILLA'S INTEGRATION TEAM:
//   1. Exact JSON payload shape they'll POST (field names for the
//      recording URL, transcript, AI summary/coaching score, appointment
//      time, and rep name)
//   2. What key we can match back to our own survey record — ideally we
//      pass them our surveyId when the appointment is booked in Rilla, and
//      they echo it back in the webhook. If they can only give us a
//      customer name + appointment time + rep email, matching is fuzzier
//      and this function will need adjusting to do a best-effort lookup
//      instead of an exact ID match.
//   3. How they authenticate outbound webhooks (a shared secret header is
//      typical) — RILLA_WEBHOOK_SECRET below is a placeholder for that.
//
// Until those are confirmed, this endpoint safely accepts a reasonable
// generic shape and stores it — it won't silently fail, but the exact
// field names WILL need adjusting once Rilla's docs are in hand.
exports.onRillaWebhook = onRequest({ cors: true, secrets: ["RILLA_WEBHOOK_SECRET"] }, async (req, res) => {
  const sharedSecret = process.env.RILLA_WEBHOOK_SECRET;
  if (sharedSecret) {
    const provided = req.headers["x-rilla-signature"] || req.headers["authorization"];
    if (provided !== sharedSecret) {
      return res.status(401).json({ error: "Invalid webhook signature." });
    }
  }

  const payload = req.body || {};
  // Best-effort field extraction — adjust these keys once Rilla confirms
  // their actual payload shape.
  const surveyId = payload.surveyId || payload.externalId || payload.crmId || null;
  const recordingUrl = payload.recordingUrl || payload.audioUrl || null;
  const transcript = payload.transcript || null;
  const summary = payload.summary || payload.aiSummary || null;
  const repName = payload.repName || payload.salesRep || null;
  const appointmentTime = payload.appointmentTime || payload.timestamp || null;

  if (!surveyId) {
    console.warn("Rilla webhook received with no matchable surveyId — logging only.", payload);
    return res.status(200).json({ ok: true, matched: false, note: "No surveyId in payload; stored nowhere. Confirm matching key with Rilla." });
  }

  const ref = db.collection("surveys").doc(String(surveyId));
  const snap = await ref.get();
  if (!snap.exists) {
    return res.status(200).json({ ok: true, matched: false, note: "surveyId did not match an existing project." });
  }

  await ref.set({
    rillaRecording: {
      recordingUrl,
      transcript,
      summary,
      repName,
      appointmentTime,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  }, { merge: true });

  res.json({ ok: true, matched: true });
});

