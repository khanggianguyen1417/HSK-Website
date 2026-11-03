# Google Sheets sync for HSK Website

The website's complete seed dataset is about 80 KB of JSON, so it must not be stored in one Google Sheets cell. The v2 backend stores one lesson per row in a dedicated tab named `HSK_Data_v2`, with the lesson JSON in column D.

## Install the backend

1. Open the existing Google Spreadsheet used by the HSK website.
2. Choose **Extensions → Apps Script**. This is important: it binds the script to the intended spreadsheet.
3. Back up the current `Code.gs` content to a separate text file, then replace it with this folder's `Code.gs`.
4. Leave `SPREADSHEET_ID` blank when the script is opened from the spreadsheet. For a standalone Apps Script project, enter the spreadsheet ID instead.
5. Save. Run `testSpreadsheetAccess` once in the editor and approve Google Sheets / external request permissions if asked. Verify the Execution log shows the correct spreadsheet name.
6. Choose **Deploy → Manage deployments**, edit the existing Web App deployment, select **New version**, keep **Execute as: Me**, and set access to **Anyone**. POST requests are separately authenticated by Google ID token and an email allowlist in the script.
7. Deploy the new version. Editing the existing deployment should keep the current `/exec` URL. If you create a new deployment instead, update `SCRIPT_URL` in `index.html` to the new URL.

## What this backend does

- `GET ?schema=2` returns `{schemaVersion: 2, data: [...]}`.
- `POST ?schema=2` requires both the full data snapshot and a Google ID token.
- The server verifies the token's issuer, audience/client ID, expiry, verified email, and exact admin email before writing.
- The v2 tab is written one lesson per row, keeping the old A1 database untouched as a migration fallback.
- A previous v2 snapshot is copied into `HSK_Data_v2_backup` before every replacement.
- Learners can read the public vocabulary data; only the allowlisted admin account can write.

## Troubleshoot a failed first write

The schema response includes a safe `syncDiagnostic` object. It records only the last write status, phase, a short error message, lesson count, and timestamp. It never records the Google ID token or the submitted vocabulary data.

After replacing/deploying this backend version, open `/exec?schema=2` and inspect `syncDiagnostic`. If a POST is rejected, the phase and error message identify whether it failed at schema validation, Google token verification, payload parsing, spreadsheet access, or writing the v2 tab.

## Test before merging the website branch

1. Open the Vercel Preview for branch `feat/google-sheets-auto-sync`.
2. The right panel should show that data was loaded from Google Sheets schema v2, or identify that the legacy backend still needs updating.
3. Sign in using the website's administrator Google account.
4. Add one temporary vocabulary item to a lesson and wait for the status `Đã đồng bộ Google Sheets thành công.`
5. Open the same Preview URL in Incognito, reload, and confirm that temporary item appears.
6. Sign in on the Incognito window to remove the temporary item, then verify its removal on the first browser.
7. Only after these tests pass, merge the website PR.

Until Apps Script is upgraded and the Preview test passes, the website will continue to keep a local browser backup and will not send writes to the legacy endpoint.