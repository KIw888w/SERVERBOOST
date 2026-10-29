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
setupCustomerShop(client, melodyService);

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

client.login(token).catch((err) => {
  console.error('login ไม่สำเร็จ:', err.message);
  process.exit(1);
});
