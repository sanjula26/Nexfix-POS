# Nexfix POS Google Apps Script API Key

The Nexfix POS Google Apps Script integration uses an operator-configured API key.

## Apps Script setup

1. Open the Google Apps Script project used by Nexfix POS.
2. Open **Project Settings → Script properties**.
3. Add the property `NEXFIX_API_KEY`.
4. Set its value to a long random string (32+ random characters recommended).
5. Deploy the project as a Web app, executing as the spreadsheet owner/operator.
6. Use the deployed `/macros/s/.../exec` URL in Nexfix POS.

The repository's `google-apps-script/Code.gs` requires this key for backup writes, backup-status acknowledgements, and table reads. Missing or incorrect keys are rejected.

## POS setup

The POS reads the key from `VITE_GOOGLE_SCRIPT_API_KEY` when provided at build time, or from browser local storage after an operator enters it when the Google integration first needs authentication. The key is never committed to the repository.

Because a browser-visible key cannot be a true secret, this key is an access gate rather than the primary security boundary. Do not use it as a substitute for Supabase authentication/RLS or Google account permissions.

## Restore safety

Google restore is destructive to the current local dataset. The POS requires an explicit confirmation and creates a local safety checkpoint before applying the validated cloud snapshot. Cloud restore is not a multi-PC merge operation.

If a key is exposed, rotate `NEXFIX_API_KEY` in Apps Script and clear/re-enter the browser's stored key.
