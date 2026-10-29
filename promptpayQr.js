'use strict';
/**
 * promptpayQr.js — สร้าง QR PromptPay เป็น PNG พร้อมข้อความตกแต่ง
 * รองรับภาษาไทยบนโฮสต์ที่ไม่มีฟอนต์ไทย โดยโหลดฟอนต์จากโฟลเดอร์ ./fonts
 */

// ===== ตั้งค่าฟอนต์ให้ librsvg (ต้องทำ "ก่อน" require('sharp')) =====
const fs = require('fs');
const os = require('os');
const path = require('path');

const FONT_DIR = path.join(__dirname, 'fonts');
const FC_DIR = path.join(os.tmpdir(), 'comet-fontconfig');

// ฟอนต์ที่เจอในโฟลเดอร์ fonts/ (ไว้เช็กว่าอัปขึ้นโฮสต์ครบหรือยัง)
let bundled = [];
try {
  bundled = fs.readdirSync(FONT_DIR).filter((f) => /\.(ttf|otf|ttc)$/i.test(f));
} catch (_) {}
console.log(`[promptpayQr] โฟลเดอร์ฟอนต์: ${FONT_DIR}`);
console.log(`[promptpayQr] พบฟอนต์ ${bundled.length} ไฟล์: ${bundled.join(', ') || '(ไม่มี)'}`);

try {
  fs.mkdirSync(path.join(FC_DIR, 'cache'), { recursive: true });
  const FC_FILE = path.join(FC_DIR, 'fonts.conf');
  // รวมฟอนต์ของโปรเจกต์ + ฟอนต์ของระบบ เพื่อไม่ให้ตัวอังกฤษหาย
  const dirs = [
    FONT_DIR,
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    path.join(os.homedir(), '.fonts'),
    path.join(os.homedir(), '.local/share/fonts'),
  ];
  fs.writeFileSync(
    FC_FILE,
    `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
${dirs.map((d) => `  <dir>${d}</dir>`).join('\n')}
  <cachedir>${path.join(FC_DIR, 'cache')}</cachedir>
</fontconfig>`
  );
  process.env.FONTCONFIG_FILE = FC_FILE;
  process.env.FONTCONFIG_PATH = FC_DIR;
} catch (err) {
  console.error('[promptpayQr] ตั้งค่า fontconfig ไม่สำเร็จ:', err.message);
}
// ==================================================================

const generatePayload = require('promptpay-qr');
const QRCode = require('qrcode');
const sharp = require('sharp');

const WARNING_TEXT = '⚠ โปรดระวัง มิจฉาชีพหลอก ⚠';
const FOOTER_TEXT = '⇢ ˗ˏˋ ℂ𝕆𝕄𝔼𝕋 ℕ𝔼𝕎 ࿐ྂ';

// ลำดับ fallback: ไทย → ละติน → math → tibetan → symbols
const FONT_FAMILY =
  "Noto Sans Thai, Noto Sans, Noto Sans Math, Noto Sans Tibetan, Noto Sans Symbols 2, sans-serif";

const DEFAULT_LOGO_URL =
  'https://cdn.discordapp.com/attachments/1558800783133249708/1565230779942961234/logo-removebg-preview.png?ex=6ae42642&is=6ae2d4c2&hm=938a4989c89f9005e3ab9d45abcbaf2fb142bb69879a49aa4dafc954b2e062ba&';

let logoCache = null;
async function loadLogo(url) {
  if (logoCache && logoCache.url === url) return logoCache.buf;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  logoCache = { url, buf };
  return buf;
}

/**
 * @param {string} promptpayNumber เบอร์โทร / เลขบัตรประชาชน
 * @param {number} amount จำนวนเงิน (บาท)
 * @param {object} [opts]
 * @param {string} [opts.logoUrl] URL โลโก้กลาง QR
 * @returns {Promise<Buffer>} PNG buffer
 */
async function promptPayQrPng(promptpayNumber, amount, opts = {}) {
  const logoUrl = opts.logoUrl || DEFAULT_LOGO_URL;

  // 1) payload
  const payload = generatePayload(promptpayNumber, { amount });

  // 2) QR
  const qrSize = 400;
  const qrPng = await QRCode.toBuffer(payload, {
    type: 'png',
    width: qrSize,
    margin: 2,
    errorCorrectionLevel: 'H',
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  // 3) โลโก้กลาง QR
  let qrWithLogo = qrPng;
  if (logoUrl) {
    try {
      const logoBuf = await loadLogo(logoUrl);
      const logoSize = Math.round(qrSize * 0.22);
      const logoResized = await sharp(logoBuf)
        .resize(logoSize, logoSize, {
          fit: 'contain',
          background: { r: 255, g: 255, b: 255, alpha: 0 },
        })
        .png()
        .toBuffer();

      const offset = Math.round((qrSize - logoSize) / 2);

      // พื้นขาวรองหลังโลโก้
      const bgSize = logoSize + 12;
      const bgOffset = Math.round((qrSize - bgSize) / 2);
      const whiteBg = await sharp({
        create: {
          width: bgSize,
          height: bgSize,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      qrWithLogo = await sharp(qrPng)
        .composite([
          { input: whiteBg, left: bgOffset, top: bgOffset },
          { input: logoResized, left: offset, top: offset },
        ])
        .png()
        .toBuffer();
    } catch (err) {
      console.error('[promptpayQr] โหลดโลโก้ไม่สำเร็จ:', err.message, '— สร้าง QR ไม่มีโลโก้');
    }
  }

  // 4) รวมภาพ (QR + ข้อความเตือน + footer)
  const canvasWidth = qrSize + 60;
  const topBarHeight = 36;
  const bottomBarHeight = 32;
  const canvasHeight = topBarHeight + qrSize + bottomBarHeight + 20;
  const qrLeft = Math.round((canvasWidth - qrSize) / 2);
  const qrTop = topBarHeight + 6;

  const svgOverlay = Buffer.from(`
    <svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${canvasWidth}" height="${canvasHeight}" rx="12" fill="#1a1a2e"/>
      <rect x="${qrLeft - 4}" y="${qrTop - 4}" width="${qrSize + 8}" height="${qrSize + 8}" rx="8" fill="none" stroke="#e94560" stroke-width="2.5"/>
      <text x="${canvasWidth / 2}" y="${topBarHeight - 8}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="15" font-weight="bold" fill="#e94560">${escapeXml(WARNING_TEXT)}</text>
      <text x="${canvasWidth / 2}" y="${canvasHeight - 8}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="13" fill="#a0a0c0">${escapeXml(FOOTER_TEXT)}</text>
    </svg>
  `);

  return sharp(svgOverlay)
    .composite([{ input: qrWithLogo, left: qrLeft, top: qrTop }])
    .png()
    .toBuffer();
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { promptPayQrPng };
