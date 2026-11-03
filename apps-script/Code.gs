/**
 * HSK Website — Google Sheets sync backend (schema v2)
 *
 * Storage:
 * - New tab: HSK_Data_v2
 * - One lesson per row; column D contains that lesson's JSON.
 * - The old A1-based database is read as a migration fallback and is never cleared.
 *
 * Security:
 * - GET is public/read-only for learners.
 * - POST verifies the Google Identity Services ID token server-side,
 *   checks its OAuth audience, issuer, expiry, verified email, and admin allowlist.
 *
 * Open this file inside the target spreadsheet via Extensions > Apps Script.
 * If this is a standalone script, set SPREADSHEET_ID below.
 */

const SPREADSHEET_ID = '';
const DATA_SHEET_NAME = 'HSK_Data_v2';
const BACKUP_SHEET_NAME = 'HSK_Data_v2_backup';
const GOOGLE_CLIENT_ID = '964510640088-or6gu50cooa8pccmcoalil9p34pim98r.apps.googleusercontent.com';
const ALLOWED_ADMIN_EMAIL = 'kanemiller1417@gmail.com';
const SCHEMA_VERSION = 2;
const MAX_LESSONS = 100;
const MAX_LESSON_JSON_CHARS = 45000;

function doGet(e) {
  try {
    const result = readAllLessons_();
    const schemaRequested = e && e.parameter && String(e.parameter.schema || '') === '2';

    if (schemaRequested) {
      return jsonOutput_({
        schemaVersion: SCHEMA_VERSION,
        data: result.lessons,
        source: result.source,
        updatedAt: result.updatedAt || null
      });
    }

    return jsonOutput_(result.lessons);
  } catch (error) {
    return jsonOutput_({
      schemaVersion: SCHEMA_VERSION,
      error: String(error && error.message || error),
      data: []
    });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();

  try {
    if (!e || !e.parameter || String(e.parameter.schema || '') !== '2') {
      throw new Error('Unsupported schema.');
    }

    const auth = verifyAdminToken_(String(e.parameter.idToken || ''));
    if (!auth.ok) throw new Error(auth.error || 'Unauthorized.');

    const rawData = String(e.parameter.data || '');
    if (!rawData) throw new Error('Missing data.');

    const parsed = JSON.parse(rawData);
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_LESSONS) {
      throw new Error('Invalid lesson array.');
    }

    const timestamp = new Date();
    const rows = [['level', 'lesson', 'title', 'payload_json', 'updated_at']];
    const seen = {};

    parsed.forEach(function (lesson) {
      if (!lesson || typeof lesson !== 'object') throw new Error('Invalid lesson object.');

      const level = Number(lesson.level || 2);
      const lessonNumber = Number(lesson.lesson);
      if (!Number.isFinite(level) || !Number.isInteger(lessonNumber) || lessonNumber < 1) {
        throw new Error('Invalid level/lesson number.');
      }

      const key = level + '-' + lessonNumber;
      if (seen[key]) throw new Error('Duplicate lesson: ' + key);
      seen[key] = true;

      const normalized = Object.assign({}, lesson, {level: level, lesson: lessonNumber});
      const payload = JSON.stringify(normalized);
      if (payload.length > MAX_LESSON_JSON_CHARS) throw new Error('Lesson ' + key + ' is too large.');

      rows.push([level, lessonNumber, String(normalized.title || ''), payload, timestamp]);
    });

    lock.waitLock(30000);
    try {
      const spreadsheet = getSpreadsheet_();
      let dataSheet = spreadsheet.getSheetByName(DATA_SHEET_NAME);
      if (!dataSheet) dataSheet = spreadsheet.insertSheet(DATA_SHEET_NAME);

      // Keep the previous v2 snapshot in a separate backup tab before replacing it.
      if (dataSheet.getLastRow() > 0) {
        let backupSheet = spreadsheet.getSheetByName(BACKUP_SHEET_NAME);
        if (!backupSheet) backupSheet = spreadsheet.insertSheet(BACKUP_SHEET_NAME);
        backupSheet.clearContents();
        const oldRows = dataSheet.getDataRange().getValues();
        if (oldRows.length && oldRows[0].length) {
          backupSheet.getRange(1, 1, oldRows.length, oldRows[0].length).setValues(oldRows);
        }
      }

      dataSheet.clearContents();
      dataSheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
      dataSheet.setFrozenRows(1);
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }

    return jsonOutput_({
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      lessonCount: parsed.length,
      updatedAt: timestamp.toISOString()
    });
  } catch (error) {
    try {
      if (lock.hasLock()) lock.releaseLock();
    } catch (ignored) {}

    return jsonOutput_({
      ok: false,
      schemaVersion: SCHEMA_VERSION,
      error: String(error && error.message || error)
    });
  }
}

function verifyAdminToken_(idToken) {
  if (!idToken) return {ok: false, error: 'Missing Google sign-in token.'};

  try {
    const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
    const response = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
    if (response.getResponseCode() !== 200) return {ok: false, error: 'Google ID token was rejected.'};

    const claims = JSON.parse(response.getContentText());
    const issuer = String(claims.iss || '');
    const emailVerified = claims.email_verified === true || String(claims.email_verified) === 'true';
    const expiresAt = Number(claims.exp || 0);

    if (claims.aud !== GOOGLE_CLIENT_ID) return {ok: false, error: 'Wrong Google client audience.'};
    if (issuer !== 'accounts.google.com' && issuer !== 'https://accounts.google.com') {
      return {ok: false, error: 'Wrong Google token issuer.'};
    }
    if (String(claims.email || '').toLowerCase() !== ALLOWED_ADMIN_EMAIL.toLowerCase()) {
      return {ok: false, error: 'This Google account is not allowed to edit the HSK database.'};
    }
    if (!emailVerified) return {ok: false, error: 'Google email is not verified.'};
    if (!expiresAt || expiresAt <= Math.floor(Date.now() / 1000)) {
      return {ok: false, error: 'Google sign-in session has expired.'};
    }

    return {ok: true, email: claims.email};
  } catch (error) {
    return {ok: false, error: 'Could not verify Google ID token: ' + String(error)};
  }
}

function readAllLessons_() {
  const spreadsheet = getSpreadsheet_();
  const dataSheet = spreadsheet.getSheetByName(DATA_SHEET_NAME);

  if (dataSheet && dataSheet.getLastRow() >= 2) {
    const rows = dataSheet.getRange(2, 1, dataSheet.getLastRow() - 1, 5).getValues();
    const lessons = [];
    let updatedAt = null;

    rows.forEach(function (row) {
      const payload = String(row[3] || '');
      if (!payload) return;
      try {
        const lesson = JSON.parse(payload);
        if (lesson && typeof lesson === 'object') lessons.push(lesson);
        if (row[4]) updatedAt = row[4] instanceof Date ? row[4].toISOString() : String(row[4]);
      } catch (error) {
        // Skip a malformed row, but keep the other lessons readable.
      }
    });

    if (lessons.length) {
      lessons.sort(function (a, b) {
        return Number(a.level || 2) - Number(b.level || 2) || Number(a.lesson) - Number(b.lesson);
      });
      return {lessons: lessons, updatedAt: updatedAt, source: 'v2'};
    }
  }

  // Migration fallback: try to read a legacy JSON array stored in cell A1.
  // No legacy sheet/cell is cleared or modified by this code.
  return {lessons: findLegacyA1Data_(spreadsheet), updatedAt: null, source: 'legacy'};
}

function findLegacyA1Data_(spreadsheet) {
  const sheets = spreadsheet.getSheets();

  for (let i = 0; i < sheets.length; i++) {
    const value = sheets[i].getRange('A1').getValue();
    if (typeof value !== 'string') continue;

    const trimmed = value.trim();
    if (!trimmed || trimmed.charAt(0) !== '[' || trimmed.length > 50000) continue;

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch (error) {
      // Not a legacy JSON payload; try the next sheet.
    }
  }
  return [];
}

function getSpreadsheet_() {
  if (SPREADSHEET_ID) return SpreadsheetApp.openById(SPREADSHEET_ID);

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error('No active spreadsheet. Open Apps Script from the target Sheet or set SPREADSHEET_ID.');
  }
  return active;
}

function jsonOutput_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

// Run once in the Apps Script editor to confirm the correct spreadsheet is connected.
function testSpreadsheetAccess() {
  const spreadsheet = getSpreadsheet_();
  Logger.log('Connected spreadsheet: ' + spreadsheet.getName());
  Logger.log('v2 storage tab exists: ' + Boolean(spreadsheet.getSheetByName(DATA_SHEET_NAME)));
}
