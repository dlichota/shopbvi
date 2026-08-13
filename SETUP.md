# Connecting Larder Flow to your Google Sheet

The app works on its own with data stored on the device. Once these steps are
done, it reads and writes a Google Sheet instead, and queues changes made while
offline until you are back online.

Nothing here needs a code change — it is all environment variables on the Netlify
site.

## 1. Prepare the sheet

Open the spreadsheet you want to use. The **first row must be a header row**, and
the app matches your columns by their names — it does not care about their order
and it never touches columns it doesn't recognise.

| App field | Header names it recognises (any one) |
| --- | --- |
| Item name (required) | `Item`, `Name`, `Product`, `Ingredient` |
| Type | `Type`, `Category`, `Group`, `Kind` |
| Location | `Location`, `Place`, `Storage`, `Where`, `Area` |
| Stock | `Stock`, `Qty`, `Quantity`, `Count`, `On hand`, `Amount` |
| Minimum stock | `Min stock`, `Min`, `Minimum`, `Par`, `Reorder`, `Restock at` |
| In cart | `In cart`, `Cart`, `To buy`, `Buy`, `Shopping`, `Checked` |
| Notes | `Notes`, `Note`, `Comment`, `Brand`, `Details` |

Header matching ignores capitals and extra spaces. Only the item-name column is
required; any field with no matching column is simply not synced. If the sheet is
completely empty, the app writes the default header row for you on first use.

Rows are matched by item name, so you can sort, filter, colour, or add your own
extra columns freely — the app will not reorder or overwrite them.

## 2. Create a service account

The app signs in as a robot account rather than as you, so it keeps working
without anyone being logged in.

1. Go to <https://console.cloud.google.com/> and create a project (or pick one).
2. Enable the **Google Sheets API**: APIs & Services → Library → search "Google
   Sheets API" → Enable.
3. Go to APIs & Services → Credentials → **Create credentials** → **Service
   account**. Give it any name; no roles are needed.
4. Open the new service account → **Keys** → **Add key** → **Create new key** →
   **JSON**. A `.json` file downloads. It contains a private key — treat it like
   a password and do not commit it.

From that JSON file you need two values: `client_email` and `private_key`.

## 3. Share the sheet with the service account

In the spreadsheet, click **Share** and share it with the `client_email` address
(it looks like `something@your-project.iam.gserviceaccount.com`), with **Editor**
access. Without this step Google returns "permission denied" — the service
account can only see sheets that have been shared with it.

## 4. Set the environment variables

The spreadsheet id is the long string in the sheet's URL between `/d/` and
`/edit`.

Using the Netlify CLI from this directory:

```bash
netlify env:set GOOGLE_SHEETS_SPREADSHEET_ID "1AbC...xyz"
netlify env:set GOOGLE_SERVICE_ACCOUNT_EMAIL "something@your-project.iam.gserviceaccount.com"
netlify env:set GOOGLE_SERVICE_ACCOUNT_KEY "$(cat ~/Downloads/your-key.json | jq -r .private_key)"
```

Or paste them into **Site configuration → Environment variables** in the Netlify
UI. When pasting the private key by hand, include the whole thing — the
`-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines and all the
line breaks. Escaped `\n` sequences are handled too, so either form works.

The spreadsheet id variable also accepts the whole sheet URL, so pasting the
address straight from the browser works.

If you would rather not pick fields out of the downloaded key file, these
alternative names are accepted for the credentials:

| Instead of | You can use |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `GOOGLE_CLIENT_EMAIL`, or `client_email` as it is named in the key file |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | `GOOGLE_PRIVATE_KEY`, or `private_key` as it is named in the key file |
| both of the above | `GOOGLE_SERVICE_ACCOUNT_JSON` — the entire key file pasted into one variable |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | `GOOGLE_SHEET_ID`, `SPREADSHEET_ID`, `SHEET_ID` |

The `client_id` field in the key file is not used and does not need to be set.

Optional:

- `GOOGLE_SHEETS_TAB` — the tab to use. Defaults to the first tab in the sheet.
- `PANTRY_SYNC_TOKEN` — see below.

Redeploy after setting them. The app picks up the connection automatically and
the status pill in the header changes from "On this device" to "Synced".

## 5. Decide who can reach your sheet

This is worth a moment's thought. The site is public, and the sync endpoint acts
on your spreadsheet with the service account's Editor rights. **Without a sync
key, anyone who knows the site URL can read and change your sheet through it.**

For a personal pantry list on an unadvertised URL that may be fine. If it isn't,
set a shared secret:

```bash
netlify env:set PANTRY_SYNC_TOKEN "some-long-random-string"
```

The app then asks for that key once per device and stores it locally. Requests
without it are rejected. Note this is a shared password, not real user accounts —
if you want per-person logins, Netlify Identity would be the next step.

## How syncing behaves

- **The sheet is the source of truth.** On opening the app, on returning to it,
  and after any change, the app reads the sheet and updates itself.
- **Changes are queued while offline** and sent when the connection returns. One
  pending change is kept per item, holding that item's latest state. A long
  offline session goes up in batches of 200 changes at a time.
- **A failed sync retries itself**, backing off from five seconds up to two
  minutes, so a brief outage clears on its own. Tapping the status pill retries
  immediately.
- **Editing an item happens in the same panel as adding one.** Tapping an item's
  name loads its current values into the form, and the button changes to *Save
  changes*: one row per item name in the sheet means an existing name is an
  edit, not a new row.
- **Last write wins.** If you edit the same item in the sheet and in the app at
  the same time, whichever reaches the sheet last is the one that sticks. There
  is no merge or conflict prompt — for a shared pantry list this is usually what
  people expect, but it is worth knowing.
- **Deleting an item deletes the whole row**, including any extra columns of your
  own on that row. Because that cannot be taken back, the delete is held for a
  few seconds behind an **Undo** button — undo within that window and the sheet
  is never touched at all. Closing the app commits the delete rather than losing
  it.
- **Very large tabs are read in part.** Up to 20,000 rows and 100 columns
  (A–CV) are synced. If a tab is bigger than that, the app says so on the status
  pill rather than quietly ignoring the rest.
- **"Reload from sheet"** in the add-item panel discards local changes and pulls
  the sheet fresh.

## If something is wrong

Tap the status pill in the header — when sync fails it shows the reason. The
common ones:

| Message | Fix |
| --- | --- |
| Google denied access to the spreadsheet | Share the sheet with the service account email as Editor (step 3) |
| That spreadsheet could not be found | Check `GOOGLE_SHEETS_SPREADSHEET_ID` is the id from the URL, not the whole URL |
| Google rejected the service account credentials | Re-check the email and private key, and that the Sheets API is enabled |
| No item-name column found | Add a header like `Item` to the first row of the tab |
| Google Sheets did not answer within 8 seconds | A slow or stuck upstream; nothing is lost, the app retries on its own |
| Sync is not configured | One of the three required variables is missing; the response lists which |
