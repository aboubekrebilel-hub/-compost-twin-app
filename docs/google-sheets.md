# Optional Google Sheets Sync Setup

CompostTwin Station can automatically forward every stored row (both averaged sensor rows and manual pH entries) to a Google Sheet via a Google Apps Script Web App webhook (`GOOGLE_SHEET_WEBHOOK`).

## 1. Create the Google Sheet

1. Create a new Google Sheet (e.g. `CompostTwin Station Log`).
2. Rename the first tab to `Readings` (or keep `Sheet1` and adjust the script below).
3. Add the following header row in `A1:I1`:

| A | B | C | D | E | F | G | H | I |
|---|---|---|---|---|---|---|---|---|
| `id` | `device_id` | `temperature` | `soil_moisture` | `oxygen` | `ph` | `note` | `source` | `created_at` |

## 2. Add the Google Apps Script

1. In your Google Sheet, open **Extensions → Apps Script**.
2. Replace the default `Code.gs` content with:

```javascript
function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Readings')
      || SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

    var data = JSON.parse(e.postData.contents);

    sheet.appendRow([
      data.id || '',
      data.device_id || '',
      data.temperature !== null && data.temperature !== undefined ? data.temperature : '',
      data.soil_moisture !== null && data.soil_moisture !== undefined ? data.soil_moisture : '',
      data.oxygen !== null && data.oxygen !== undefined ? data.oxygen : '',
      data.ph !== null && data.ph !== undefined ? data.ph : '',
      data.note || '',
      data.source || '',
      data.created_at || new Date().toISOString()
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

## 3. Deploy as a Web App

1. Click **Deploy → New deployment**.
2. Select type: **Web app**.
3. Set:
   - **Execute as**: `Me`
   - **Who has access**: `Anyone` (required so the Node.js server can POST without OAuth login)
4. Click **Deploy**, authorize the script permissions, and copy the **Web app URL** (`https://script.google.com/macros/s/.../exec`).

## 4. Configure CompostTwin Station

Set the copied URL in your `.env` (or Render environment variables):

```env
GOOGLE_SHEET_WEBHOOK=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
```

Restart the server. Every new stored row will now be appended to your Google Sheet automatically. Webhook errors are logged as warnings and never interrupt database storage.
