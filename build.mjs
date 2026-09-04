import { access, cp, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(projectRoot, 'dist');
const publicFiles = [
  'index.html',
  'styles.css',
  'firebase-config.js',
  'auth.js',
  'dashboard.js',
  'labelCutter.js',
  'labelParser.js',
  'labelFormats.js',
  'barcodeTools.js',
  'logoTools.js',
  'flipkartPnl.js',
  'businessTools.js',
  'skuMaster.js',
  'cloudGateway.js',
  'cloudLibrary.js',
  'team.js',
  'S_3.jpg'
];

for (const file of publicFiles) {
  await access(path.join(projectRoot, file), constants.R_OK);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await Promise.all(publicFiles.map(file => cp(path.join(projectRoot, file), path.join(outputDirectory, file))));

console.log(`Built ${publicFiles.length} files in dist/`);
