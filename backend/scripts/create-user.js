#!/usr/bin/env node
'use strict';

/**
 * Usage:
 *   node scripts/create-user.js --login <login> --role <ROLE> --password <pass>
 *
 * ROLE must be one of: USER | ADMIN | SUPERUSER
 */

const bcrypt = require('bcryptjs');
const path   = require('path');
const store  = require(path.join(__dirname, '../src/storage/store'));

const VALID_ROLES = ['USER', 'ADMIN', 'SUPERUSER'];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}

async function main() {
  const login    = arg('login');
  const role     = (arg('role') || '').toUpperCase();
  const password = arg('password');

  if (!login || !role || !password) {
    console.error('Usage: node scripts/create-user.js --login <n> --role <ROLE> --password <p>');
    process.exit(1);
  }
  if (!VALID_ROLES.includes(role)) {
    console.error(`Invalid role "${role}". Must be one of: ${VALID_ROLES.join(', ')}`);
    process.exit(1);
  }
  if (password.length < 4) {
    console.error('Password must be at least 4 characters.');
    process.exit(1);
  }

  const existing = store.findAll('users', u => u.login === login);
  if (existing.length > 0) {
    console.error(`Error: login "${login}" already exists (id=${existing[0].id}).`);
    process.exit(1);
  }

  const password_hash = await bcrypt.hash(password, 10);
  const user = store.insert('users', { login, password_hash, role });

  console.log(`✓ User created:`);
  console.log(`  id:    ${user.id}`);
  console.log(`  login: ${user.login}`);
  console.log(`  role:  ${user.role}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
