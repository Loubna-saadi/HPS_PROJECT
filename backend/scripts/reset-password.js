#!/usr/bin/env node
'use strict';

/**
 * Usage:
 *   node scripts/reset-password.js --login <login> --password <newpass>
 */

const bcrypt = require('bcryptjs');
const path   = require('path');
const store  = require(path.join(__dirname, '../src/storage/store'));

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}

async function main() {
  const login    = arg('login');
  const password = arg('password');

  if (!login || !password) {
    console.error('Usage: node scripts/reset-password.js --login <login> --password <newpass>');
    process.exit(1);
  }
  if (password.length < 4) {
    console.error('Password must be at least 4 characters.');
    process.exit(1);
  }

  const [user] = store.findAll('users', u => u.login === login);
  if (!user) {
    console.error(`Error: user "${login}" not found.`);
    process.exit(1);
  }

  const password_hash = await bcrypt.hash(password, 10);
  store.updateById('users', user.id, { password_hash });

  console.log(`✓ Password updated for "${login}" (id=${user.id})`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
