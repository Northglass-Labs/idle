#!/usr/bin/env node

// Run the CLI in this process so long-lived commands do not leave a wrapper
// retaining their original environment or an extra copy of sensitive state.
import('../dist/index.mjs').catch(() => {
  console.error('Unable to start the Idle CLI. Reinstall idle-coder.');
  process.exit(1);
});
