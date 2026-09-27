/** Direct Google Drive backup integration for Nexfix POS.
 * POS -> Google Apps Script Web App -> dedicated Google Drive folder.
 * Business-state encryption happens in the browser before anything is uploaded.
 */

import {
  decryptBackupEnvelope,
  encryptBackupState,
  isEncryptedBackupEnvelope,
  sha256Hex,
  ensureRecoveryKey,
} from './backupCrypto';

const URL_KEY = 'nexfix_google_script_url_v2';
const ENABLED_KEY = 'nexfix_google_sync_enabled';
const BUILT_IN_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycby1z0HyyJ2Nzs7hhyUFGedd_wjKoKT-FpWAikjJBRGPRNZrUt5ZF8Q5s04UwcNF7pNxRQ/exec';
// This is a transport credential, not a frontend secret. Any value compiled
// into an Electron/Vite bundle can be extracted; Apps Script still rejects
// requests that do not present the configured Script Property value.
const BACKUP_API_KEY = (import.meta.env.VITE_GOOGLE_BACKUP_API_KEY || '').trim();
const SHOP_KEY = 'nexfix_cloud_shop_id';
const DRIVE_SHOP_KEY = 'nexfix_drive_shop_id';
const DRIVE_SHOP_OVERRIDE_KEY = 'nexfix_drive_shop_id_override';
const CLOUD_SAFE_MARKER = '__nexfixCloudSafe';
const SINGLE_LIMIT_BYTES = 1.5 * 1024 * 1024;
const PART_SIZE_BYTES = 6 * 1024 * 1024;

// Keep the remainder of the existing implementation unchanged.

