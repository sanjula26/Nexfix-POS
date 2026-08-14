// Google Apps Script Deploy URL එක
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbymgneIr6qiK1PnB_-YvMukwbXb-emSRn4fOtBDgENJ5w3OwY2RBio3YD2-gjUQWOP5/exec";

/**
 * Google Sheet එකට Data Save කරන Function එක
 * @param tableName Sheet එකේ නම (eg: 'products', 'sales', 'users')
 * @param dataRows Save කරන්න ඕනි Data Arrays
 */
export async function syncToGoogleDrive(tableName: string, dataRows: any[]) {
  try {
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
      },
      body: JSON.stringify({
        action: "saveData",
        table: tableName,
        rows: dataRows,
      }),
    });

    const result = await response.json();
    console.log(`[Google Sheet Sync] ${tableName} synced successfully:`, result);
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
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
      },
      body: JSON.stringify({
        action: "getData",
        table: tableName,
      }),
    });

    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`[Google Sheet Fetch Error] Failed to load ${tableName}:`, error);
    return [];
  }
}
