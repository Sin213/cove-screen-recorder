// Builds the native helper binary and sha256 sidecar before electron-builder
// packages extraResources. No-op on non-Linux platforms.
const { execSync } = require('child_process');

if (process.platform !== 'linux') {
  console.log('[prep-helper] skipping helper build on', process.platform);
  process.exit(0);
}

execSync('cargo build --release -p cove-replay-engine', { stdio: 'inherit' });
execSync(
  'sha256sum target/release/cove-replay-engine > target/release/cove-replay-engine.sha256',
  { stdio: 'inherit', shell: true }
);
