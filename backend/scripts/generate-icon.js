#!/usr/bin/env node
'use strict';

/**
 * Generates a minimal valid 1×1 32-bit ICO placeholder at assets/icon.ico.
 * Run automatically by the preelectron:build npm script.
 * Replace assets/icon.ico with your real brand icon before shipping.
 */

const fs   = require('fs');
const path = require('path');

const iconPath = path.join(__dirname, '../assets/icon.ico');

if (fs.existsSync(iconPath)) {
  console.log('[icon] assets/icon.ico already exists — skipping generation');
  process.exit(0);
}

fs.mkdirSync(path.dirname(iconPath), { recursive: true });

// Minimal 1×1 32-bit ICO — pixel colour #1A56DB (HPS blue), fully opaque
const buf = Buffer.allocUnsafe(70);
let o = 0;

// ICO file header (6 bytes)
buf.writeUInt16LE(0,  o); o += 2; // reserved — must be 0
buf.writeUInt16LE(1,  o); o += 2; // type: 1 = ICO
buf.writeUInt16LE(1,  o); o += 2; // number of images: 1

// Image directory entry (16 bytes)
buf[o++] = 1;              // width  = 1 px
buf[o++] = 1;              // height = 1 px
buf[o++] = 0;              // colour count = 0 (32-bit, no palette)
buf[o++] = 0;              // reserved
buf.writeUInt16LE(1,  o); o += 2; // planes   = 1
buf.writeUInt16LE(32, o); o += 2; // bit count = 32
buf.writeUInt32LE(48, o); o += 4; // image data size = 40 + 4 + 4 = 48 bytes
buf.writeUInt32LE(22, o); o += 4; // offset to image data = 6 + 16 = 22

// BITMAPINFOHEADER (40 bytes)
buf.writeUInt32LE(40, o); o += 4; // header size
buf.writeInt32LE( 1,  o); o += 4; // width  = 1
buf.writeInt32LE( 2,  o); o += 4; // height = 2 (×2: XOR mask + AND mask rows)
buf.writeUInt16LE(1,  o); o += 2; // planes
buf.writeUInt16LE(32, o); o += 2; // bit count
buf.writeUInt32LE(0,  o); o += 4; // compression = BI_RGB
buf.writeUInt32LE(0,  o); o += 4; // image size (0 = auto for BI_RGB)
buf.writeInt32LE( 0,  o); o += 4; // X pixels per metre
buf.writeInt32LE( 0,  o); o += 4; // Y pixels per metre
buf.writeUInt32LE(0,  o); o += 4; // colours used
buf.writeUInt32LE(0,  o); o += 4; // colours important

// XOR pixel data — BGRA: #1A56DB fully opaque
buf[o++] = 0xDB; buf[o++] = 0x56; buf[o++] = 0x1A; buf[o++] = 0xFF;

// AND mask (4 bytes, all 0 = fully opaque)
buf.writeUInt32LE(0, o); // o += 4 — last field, no need to advance

fs.writeFileSync(iconPath, buf);
console.log('[icon] ✓ Placeholder assets/icon.ico created (replace with your real icon before shipping)');
