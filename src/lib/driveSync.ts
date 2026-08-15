// Google Apps Script Deploy URL එක
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwqgFn-6tKzAIYsaIT2zLAG6rsmCRPvqQ0iHfL4som0Pb1VoJbceaNG1EciTnpb4Yg/exec";

/**
 * Google Sheet එකට Data Save කරන Function එක
 * @param tableName Sheet එකේ නම (eg: 'Products', 'SalesHistory')
 * @param dataRows Save කරන්න ඕනි Data Arrays
 */
export async function syncToGoogleDrive(tableName: string, dataRows: any[]) {
  if (!dataRows || dataRows.length === 0) return false;

  try {
    // mode: 'no-cors' භාවිතයෙන් Browser CORS Blocking නතර කර නිවැරදිව Data යවනු ලබයි
    await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
      },
      body: JSON.stringify({
        action: "saveData",
        table: tableName,
        rows: dataRows,
      }),
    });

    console.log(`[Google Sheet Sync] Request sent successfully for ${tableName}`);
    return true;
  } catch (error) {
    console.error(`[Google Sheet Sync Error] Failed to sync ${tableName}:`, error);
    return false;
  }
}

/**
 * Google Sheet එකෙන් Data ආපසු ලබාගන්නා Function එක (Restore/Fetch)
 */
export async function fetchFromGoogleDrive(tableName: string) {
  try {
    const response = await fetch(`${GOOGLE_SCRIPT_URL}?table=${tableName}`);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`[Google Sheet Fetch Error] Failed to load ${tableName}:`, error);
    return [];
  }
}
