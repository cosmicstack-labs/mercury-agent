#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

console.log('\u263F Checking native build prerequisites for better-sqlite3...\n');

let missing = false;
const isWin = platform() === 'win32';

if (!isWin) {
  if (!commandExists('make')) {
    console.log('\u26A0  \'make\' not found \u2014 better-sqlite3 may not compile.');
    console.log('   Install with: sudo apt-get install build-essential  (Debian/Ubuntu)');
    console.log('                 sudo yum groupinstall "Development Tools"  (RHEL/CentOS)');
    missing = true;
  }
  if (!commandExists('gcc') && !commandExists('cc')) {
    console.log('\u26A0  C compiler not found \u2014 better-sqlite3 may not compile.');
    console.log('   Install with: sudo apt-get install gcc  (Debian/Ubuntu)');
    missing = true;
  }
  if (!commandExists('python3') && !commandExists('python')) {
    console.log('\u26A0  Python not found \u2014 better-sqlite3 may not compile.');
    console.log('   Install with: sudo apt-get install python3  (Debian/Ubuntu)');
    missing = true;
  }
} else {
  if (!commandExists('cl') && !commandExists('gcc')) {
    console.log('\u26A0  C compiler not found \u2014 better-sqlite3 may not compile.');
    console.log('   Install Visual Studio Build Tools: npm install --global windows-build-tools');
    console.log('   Or install Visual Studio with C++ workload.');
    missing = true;
  }
}

const nodeVersion = process.version;
const nodeMajor = parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10);

if (nodeMajor < 20) {
  console.log(`\u26A0  Node.js ${nodeVersion} detected \u2014 better-sqlite3 v12 requires Node >= 20.`);
  console.log('   Upgrade with: nvm install 20');
  missing = true;
}

if (!missing) {
  console.log('\u2713  All native build prerequisites found.\n');
} else {
  console.log('');
  console.log('   Second brain memory will be disabled until the above are resolved.');
  console.log('   The rest of mercury-agent will work fine without better-sqlite3.\n');
}

function commandExists(cmd) {
  const isWin = platform() === 'win32';
  try {
    execFileSync(isWin ? 'where.exe' : 'sh', isWin ? [cmd] : ['-c', 'command -v "$1"', 'sh', cmd], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
