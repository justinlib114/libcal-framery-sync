import "dotenv/config";
import fetch from "node-fetch";
import { google } from "googleapis";

/* =====================================================
   ENV + CONFIG
===================================================== */

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function mustNumber(name) {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v)) throw new Error(`${name} must be set and numeric`);
  return v;
}

function parseCsvNumbers(name) {
  const raw = must(name);
  const nums = raw
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n));
  if (!nums.length) throw new Error(`${name} must contain at least one numeric value`);
  return nums;
}

// LibCal
const LIBCAL_BASE = process.env.LIBCAL_BASE || "https://greenburghlibrary.libcal.com/api/1.1";
const LIBCAL_CLIENT_ID = must("LIBCAL_CLIENT_ID");
const LIBCAL_CLIENT_SECRET = must("LIBCAL_CLIENT_SECRET");

const LID = mustNumber("LIBCAL_LID");
const CID = mustNumber("LIBCAL_CID");
const ITEM_IDS = parseCsvNumbers("LIBCAL_ITEM_IDS");
const DAYS_AHEAD = Number(process.env.LIBCAL_DAYS_AHEAD || 14);

// Display
const EVENT_SUMMARY = process.env.EVENT_SUMMARY || "Pod Reservation";

// Google
const GOOGLE_SA_KEYFILE = must("GOOGLE_SA_KEYFILE"); // e.g. /etc/secrets/service-account.json
const GOOGLE_IMPERSONATE_USER = must("GOOGLE_IMPERSONATE_USER"); // libcal-sync@yourdomain.org

// We’ll map item IDs to 3 pod calendars. You can name them however you want;
// these three env vars must be set.
const POD_A_CAL_ID = must("POD_A_CAL_ID");
const POD_B_CAL_ID = must("POD_B_CAL_ID");
const POD_C_CAL_ID = must("POD_C_CAL_ID");

// Map item id → calendar id in a predictable way (sorted by item id)
const sortedItemIds = [...ITEM_IDS].sort((a, b) => a - b);
if (sortedItemIds.length !== 3) {
  throw new Error(`Expected LIBCAL_ITEM_IDS to contain exactly 3 item ids, got ${sortedItemIds.length}`);
}

const POD_CAL_MAP = {
  [sortedItemIds[0]]: POD_A_CAL_ID,
  [sortedItemIds[1]]: POD_B_CAL_ID,
  [sortedItemIds[2]]: POD_C_CAL_ID
};

console.log("Config:");
console.log({ LIBCAL_BASE, LID, CID, DAYS_AHEAD, ITEM_IDS: sortedItemIds });
console.log({
  podMap: {
    [sortedItemIds[0]]: POD_A_CAL_ID,
    [sortedItemIds[1]]: POD_B_CAL_ID,
    [sortedItemIds[2]]: POD_C_CAL_ID
  }
});

/* =====================================================
   LIBCAL
===================================================== */

async function getLibCalToken() {
  const body = new URLSearchParams({
    client_id: LIBCAL_CLIENT_ID,
    client_secret: LIBCAL_CLIENT_SECRET,
    grant_type: "client_credentials"
  });

  const res = await fetch(`${LIBCAL_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!res.ok) {
    throw new Error(`LibCal token failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  if (!json.access_token) throw new Error("LibCal token response missing access_token");
  return json.access_token;
}

function yyyymmddLocal(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function getBookings(token) {
  const date = yyyymmddLocal(new Date());

  const url =
    `${LIBCAL_BASE}/space/bookings` +
    `?lid=${LID}` +
    `&cid=${CID}` +
    `&date=${date}` +
    `&days=${DAYS_AHEAD}` +
    `&include_cancel=1` +
    `&limit=500&page=1`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    throw new Error(`LibCal bookings failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const arr = Array.isArray(data) ? data : (data?.bookings ?? data?.results ?? []);
  return arr;
}

// Status helpers (adjust if your LibCal uses different strings)
function isActiveStatus(status) {
  return ["confirmed", "approved", "active"].includes(String(status || "").toLowerCase());
}

/* =====================================================
   GOOGLE
===================================================== */

function getCalendarClient() {
  const auth = new google.auth.JWT({
    keyFile: GOOGLE_SA_KEYFILE,
    scopes: ["https://www.googleapis.com/auth/calendar"],
    subject: GOOGLE_IMPERSONATE_USER
  });

  return google.calendar({ version: "v3", auth });
}

function isoNow() {
  return new Date().toISOString();
}

function isoDaysAhead(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function isOurSyncedEvent(ev) {
  const priv = ev?.extendedProperties?.private;
  return priv?.libcalBookingId && priv?.libcalItemId;
}

function getLibcalIdFromEvent(ev) {
  const v = ev?.extendedProperties?.private?.libcalBookingId;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function eventBody(b) {
  return {
    summary: EVENT_SUMMARY,
    description: `Synced from LibCal.\nLibCal booking ID: ${b.id}\nLibCal item ID: ${b.item_id}`,
    start: { dateTime: b.fromDate },
    end: { dateTime: b.toDate },
    extendedProperties: {
      private: {
        libcalBookingId: String(b.id),
        libcalItemId: String(b.item_id)
      }
    }
  };
}

async function listGoogleEvents(calendar, calendarId) {
  const resp = await calendar.events.list({
    calendarId,
    timeMin: isoNow(),
    timeMax: isoDaysAhead(DAYS_AHEAD),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 2500
  });
  return resp.data?.items || [];
}

/* =====================================================
   SYNC (NO DB)
===================================================== */

async function syncOnePodCalendar({ calendar, calendarId, libcalBookingsForItem }) {
  // Desired: only active bookings
  const desiredById = new Map();
  for (const b of libcalBookingsForItem) {
    if (!Number.isFinite(Number(b.id))) continue;
    if (!isActiveStatus(b.status)) continue;
    desiredById.set(Number(b.id), b);
  }

  // Existing: only our events
  const existingEvents = await listGoogleEvents(calendar, calendarId);
  const existingByLibcalId = new Map();

  for (const ev of existingEvents) {
    if (!isOurSyncedEvent(ev)) continue;
    const libcalId = getLibcalIdFromEvent(ev);
    if (libcalId) existingByLibcalId.set(libcalId, ev);
  }

  // Create or update
  for (const [libcalId, booking] of desiredById.entries()) {
    const existing = existingByLibcalId.get(libcalId);

    if (!existing) {
      const created = await calendar.events.insert({
        calendarId,
        requestBody: eventBody(booking)
      });
      console.log(`[${calendarId}] created event for LibCal booking ${libcalId}: ${created.data?.id}`);
      continue;
    }

    const changed =
      existing?.start?.dateTime !== booking.fromDate ||
      existing?.end?.dateTime !== booking.toDate ||
      existing?.summary !== EVENT_SUMMARY;

    if (changed) {
      await calendar.events.patch({
        calendarId,
        eventId: existing.id,
        requestBody: eventBody(booking)
      });
      console.log(`[${calendarId}] updated event for LibCal booking ${libcalId}`);
    }
  }

  // Delete events that no longer exist in LibCal active set (within window)
  for (const [libcalId, ev] of existingByLibcalId.entries()) {
    if (!desiredById.has(libcalId)) {
      await calendar.events.delete({ calendarId, eventId: ev.id });
      console.log(`[${calendarId}] deleted event for LibCal booking ${libcalId} (not in active set)`);
    }
  }
}

/* =====================================================
   MAIN
===================================================== */

(async () => {
  try {
    const token = await getLibCalToken();
    const raw = await getBookings(token);

    // Filter to item IDs only
    const bookings = raw.filter(b => ITEM_IDS.includes(Number(b.item_id)));

    console.log(`LibCal returned ${raw.length} bookings; ${bookings.length} match ITEM_IDS.`);

    const calendar = getCalendarClient();

    for (const itemId of sortedItemIds) {
      const calendarId = POD_CAL_MAP[itemId];
      const forItem = bookings.filter(b => Number(b.item_id) === itemId);

      if (!calendarId) {
        console.warn(`No calendarId mapped for itemId ${itemId}. Skipping.`);
        continue;
      }

      console.log(`Syncing itemId ${itemId} → calendar ${calendarId} (${forItem.length} bookings)`);
      await syncOnePodCalendar({ calendar, calendarId, libcalBookingsForItem: forItem });
    }

    console.log("Sync complete.");
  } catch (err) {
    console.error("Sync failed:", err?.message || err);
    process.exit(1);
  }
})();
