'use strict';
// บอทตัวใหม่สำหรับสั่งบูสต์ผ่าน Melody Boost — รันด้วย: node index.js
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { setupMelodyBoost } = require('./melodyBoost');
const { setupCustomerShop } = require('./customerShop');

const token = (process.env.DISCORD_TOKEN || '').trim();
if (!token || token.toUpperCase().startsWith('YOUR_')) {
  console.error('ไม่พบ DISCORD_TOKEN ในไฟล์ .env (คัดลอก .env.example เป็น .env แล้วใส่โทเค็นบอท)');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // ต้องเปิด MESSAGE CONTENT INTENT ใน Developer Portal ด้วย
  ],
});

let announced = false;
const onReady = () => {
  if (announced) return;
  announced = true;
  console.log(`บอทออนไลน์แล้ว: ${client.user.tag}`);
};
client.once('ready', onReady);
client.once('clientReady', onReady);

// ถ้าตั้งค่า Melody ไม่ครบ (เช่น ไม่มี MELODY_API_KEY) จะแจ้งสาเหตุแล้วปิดโปรแกรม
const melodyService = setupMelodyBoost(client);
if (!melodyService) process.exit(1);

// ตั้งค่าหน้าร้านลูกค้า (ถ้าเปิดไม่ได้จะแจ้งเตือนแต่ไม่หยุดโปรแกรม)
const shop = setupCustomerShop(client, melodyService);

// ปิดบอทอย่างเรียบร้อย (Ctrl+C / โฮสต์สั่งหยุด): รอให้งานเขียนกระเป๋าเครดิตที่ค้างอยู่เสร็จก่อนค่อยออก
// ไฟล์เขียนแบบ atomic อยู่แล้ว ต่อให้ถูกฆ่ากลางคัน ออเดอร์/การเติมเงินที่ค้างก็จะถูกกู้ตอนเปิดใหม่
let shuttingDown = false;
const shutdown = async (sig) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`ได้รับ ${sig} — กำลังปิดบอท (รอบันทึกกระเป๋าเครดิตให้เสร็จ)...`);
  const force = setTimeout(() => process.exit(1), 8_000);
  if (force.unref) force.unref();
  try {
    if (shop && shop.drain) await shop.drain();
  } catch (_) {}
  try {
    await client.destroy();
  } catch (_) {}
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

client.login(token).catch((err) => {
  console.error('login ไม่สำเร็จ:', err.message);
  process.exit(1);
});
