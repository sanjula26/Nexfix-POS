import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const scanRoots = ['src', 'electron', 'public', 'supabase', 'package.json'];
const forbiddenCredentialPattern = /SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE|service_role["' ]*[:=]|BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY|PRIVATE_KEY/;
const forbiddenDemoCredentialPattern = /admin123|cashier123/;
const errors = [];

function filesUnder(path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [absolute];
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(relative(root, child)));
    else files.push(child);
  }
  return files;
}

for (const file of scanRoots.flatMap(filesUnder)) {
  const text = readFileSync(file, 'utf8');
  const display = relative(root, file);
  if (forbiddenCredentialPattern.test(text)) errors.push(`${display}: possible private credential or service-role reference`);
  if (!display.endsWith('seed.ts') && !display.endsWith('store.tsx') && forbiddenDemoCredentialPattern.test(text)) {
    errors.push(`${display}: retired demo credential literal found outside guarded seed/state code`);
  }
}

for (const file of ['.env', '.env.local', '.env.production', 'service-account.json']) {
  if (existsSync(join(root, file))) errors.push(`${file}: secret/config file must not be present in the repository workspace`);
}

for (const workflowRoot of ['.github/workflows']) {
  for (const file of filesUnder(workflowRoot).filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))) {
    const text = readFileSync(file, 'utf8');
    if (/VITE_SEED_DEMO\s*=\s*true|VITE_SEED_DEMO=true/.test(text)) {
      errors.push(`${relative(root, file)}: production workflow must not enable demo seed data`);
    }
  }
}

if (errors.length) {
  console.error('Production boundary check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Production boundary check passed.');
