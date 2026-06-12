#!/usr/bin/env node
'use strict';

/**
 * Usage:
 *   node scripts/list-users.js
 *
 * Prints all users — never prints passwords.
 */

const path  = require('path');
const store = require(path.join(__dirname, '../src/storage/store'));

const users = store.findAll('users');

if (users.length === 0) {
  console.log('No users found. Create one with:');
  console.log('  node scripts/create-user.js --login admin --role SUPERUSER --password <pass>');
  process.exit(0);
}

console.log(`\n${'ID'.padEnd(6)} ${'LOGIN'.padEnd(20)} ${'ROLE'.padEnd(12)} CREATED_AT`);
console.log('-'.repeat(70));
for (const u of users) {
  const id      = String(u.id).padEnd(6);
  const login   = (u.login || '').padEnd(20);
  const role    = (u.role  || '').padEnd(12);
  const created = u.created_at ? new Date(u.created_at).toLocaleString() : '—';
  console.log(`${id} ${login} ${role} ${created}`);
}
console.log();
