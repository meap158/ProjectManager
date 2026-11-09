#!/usr/bin/env node
/* global process */
// ProjectManager card-link warning hook. Always succeeds, even on unreadable messages.
void (async () => {
  try {
    const fs = await import('node:fs');
    const message = fs.readFileSync(process.argv[2], 'utf8');
    const lines = message.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#'));
    if (!lines.some((line) => /^\s*(?:Refs|Fixes)(?::|\s)\s*PM-[1-9]\d*\b/i.test(line))) {
      process.stderr.write(
        'ProjectManager: add a Refs PM-n or Fixes PM-n trailer to link this commit to a card. Commit allowed.\n',
      );
    }
  } catch {
    process.stderr.write('ProjectManager: could not inspect the commit message. Commit allowed.\n');
  }
  process.exitCode = 0;
})();
