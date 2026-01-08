# LibCal → Framery Sync (No DB)

Syncs LibCal **Spaces** bookings to Google Workspace **resource calendars** used by Framery pods.

## How it works
- Fetch LibCal bookings for a window (today → N days)
- For each pod/resource calendar:
  - List existing Google events in the same window
  - Match events created by this script using `extendedProperties.private.libcalBookingId`
  - Create missing events
  - Update changed events
  - Delete events that no longer exist in LibCal's active set

No database required.

## Run locally
1. `npm install`
2. Set env vars (see below)
3. `npm run sync`

## Deploy on Render
Use a **Cron Job**:
- Build Command: `npm install`
- Start Command: `npm run sync`
- Schedule: every 2–5 minutes

### Secret file
Upload your Google service account JSON as a Render Secret File:
- Path: `/etc/secrets/service-account.json`

Then set:
- `GOOGLE_SA_KEYFILE=/etc/secrets/service-account.json`

## Required environment variables

### LibCal
- `LIBCAL_CLIENT_ID`
- `LIBCAL_CLIENT_SECRET`
- `LIBCAL_LID`
- `LIBCAL_CID`
- `LIBCAL_ITEM_IDS` (comma-separated)
- `LIBCAL_DAYS_AHEAD` (optional, default 14)

### Google
- `GOOGLE_SA_KEYFILE`
- `GOOGLE_IMPERSONATE_USER`
- `POD_A_CAL_ID`
- `POD_B_CAL_ID`
- `POD_C_CAL_ID`

## Notes
- Only events created by this script (with private extendedProperties) will be updated/deleted.
- The summary shown on Framery is controlled by `EVENT_SUMMARY` (optional).
