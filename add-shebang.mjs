import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cpSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Add shebang to index.js
const indexPath = path.join(__dirname, 'dist', 'index.js');
const content = fs.readFileSync(indexPath, 'utf8');

if (!content.startsWith('#!/usr/bin/env node')) {
  fs.writeFileSync(indexPath, '#!/usr/bin/env node\n' + content);
  console.log('Added shebang to dist/index.js');
} else {
  console.log('Shebang already present in dist/index.js');
}

// Copy hook scripts so install.ts can read them at runtime
const srcHooks = path.join(__dirname, 'src', 'hooks');
const distHooks = path.join(__dirname, 'dist', 'hooks');
fs.mkdirSync(distHooks, { recursive: true });
cpSync(srcHooks, distHooks, { recursive: true });
console.log('Copied src/hooks to dist/hooks');
