import fs from 'fs';
import path from 'path';

const __dirname = path.resolve();
const MODELS_DIR = path.join(__dirname, 'public', 'models');

if (!fs.existsSync(MODELS_DIR)) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
}

const BASE_URL = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights';
const files = [
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model-shard1',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1'
];

async function downloadFile(file) {
  const dest = path.join(MODELS_DIR, file);
  if (fs.existsSync(dest)) {
    console.log(`${file} already exists, skipping.`);
    return;
  }
  const url = `${BASE_URL}/${file}`;
  console.log(`Downloading ${url}...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${file}: ${res.statusText}`);
  }
  const buffer = await res.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buffer));
  console.log(`Saved ${file}`);
}

async function main() {
  for (const file of files) {
    try {
      await downloadFile(file);
    } catch (err) {
      console.error(`Error downloading ${file}:`, err);
      process.exit(1);
    }
  }
  console.log('All models downloaded successfully.');
}

main();
