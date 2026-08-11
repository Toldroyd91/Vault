/**
 * scripts/bootstrapStaffAccount.js
 * -----------------------------------------------------------------------
 * One-off helper for granting the very first admin account access to the
 * dashboard. After this, use the app itself (or a small internal tool
 * calling the grantStaffRole Cloud Function) to add further staff — you
 * should not need to run this script again except in an emergency.
 *
 * WHY THIS EXISTS:
 * The dashboard now requires a real Firebase Authentication account with
 * a custom claim of role: 'designer' or role: 'admin'. On a brand new
 * project nobody has that claim yet, so grantStaffRole (which normally
 * requires the caller to already be an admin) accepts one exception: a
 * shared secret set as an environment variable, used only for this first
 * bootstrap step.
 *
 * SEE SETUP.md for the full walkthrough. Short version:
 *   1. Create the person's account in the Firebase console:
 *      Authentication -> Users -> Add user (email + password)
 *   2. Put a value for ADMIN_BOOTSTRAP_SECRET in functions/.env.secrets,
 *      then run ./scripts/push-secrets.sh to upload it
 *   3. Deploy functions:
 *        firebase deploy --only functions
 *   4. Run this script:
 *        node scripts/bootstrapStaffAccount.js you@yourcompany.com admin YOUR_SECRET_HERE
 *      (the secret value is whatever you put in functions/.env.secrets)
 *
 * After that, sign in on the dashboard as normal. To add further staff,
 * call grantStaffRole from an authenticated admin session instead of
 * this script — e.g. from browser dev tools while logged in as admin:
 *
 *   import { functions, httpsCallable } from './js/core-firebase.js';
 *   const grant = httpsCallable(functions, 'grantStaffRole');
 *   await grant({ email: 'newperson@yorkshirewindows.com', role: 'designer' });
 * -----------------------------------------------------------------------
 */

const [, , email, role, bootstrapSecret] = process.argv;

if (!email || !role || !bootstrapSecret) {
  console.error("Usage: node scripts/bootstrapStaffAccount.js <email> <admin|designer> <bootstrapSecret>");
  process.exit(1);
}

const PROJECT_REGION = "us-central1"; // change if you deployed functions elsewhere
const PROJECT_ID = "cohi-survey-engine";

async function main() {
  const url = `https://${PROJECT_REGION}-${PROJECT_ID}.cloudfunctions.net/grantStaffRole`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { email, role, bootstrapSecret } }),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    console.error("Failed:", json.error || json);
    process.exit(1);
  }
  console.log("Success:", json.result);
}

main();
