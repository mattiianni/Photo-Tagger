import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Kill any existing process on port 3001 (handling multiple PIDs cleanly with xargs)
try {
  execSync('lsof -t -i :3001 2>/dev/null | xargs kill -9 2>/dev/null || true');
} catch (e) {}

// 2. Spawn fully detached backend server
const child = spawn(process.execPath, [path.join(__dirname, 'backend/server.js')], {
  detached: true,
  stdio: 'ignore',
  cwd: __dirname
});

child.unref();
console.log('DAEMON_STARTED', child.pid);
process.exit(0);
