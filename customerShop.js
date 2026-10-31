'use strict';
/**
 * customerShop.js — หน้าร้านสำหรับ "ลูกค้า" สั่งบูสต์เองแบบออโต้ (ไม่ต้องพิมพ์คำสั่ง ไม่ต้องรอแอดมิน)
 *
 * ภาพรวม:
 *  1) ลูกค้ากด "เติมเครดิต" -> กรอกยอดโอนในฟอร์ม -> โอนเงินจริง -> แนบรูปสลิปในแชท
 *     บอทส่งสลิปไปตรวจกับ SlipOK (ยอด + ผู้รับ + กันสลิปซ้ำ) ผ่านแล้วเติมเครดิตเข้ากระเป๋าลูกค้าทันที
 *  2) ลูกค้าเลือกแพ็กจาก dropdown -> กรอกลิงก์เซิร์ฟเวอร์ + จำนวนในฟอร์ม (modal) กดส่ง
 *     ระบบคำนวณราคา เช็คเครดิต หักเครดิตทันที แล้วยิงคำสั่งบูสต์ไปที่ Melody โดยอัตโนมัติ ไม่มีปุ่มยืนยันซ้ำ
 *  3) ถ้าออเดอร์ถูกปฏิเสธตั้งแต่ต้น (ไม่เกิดออเดอร์จริง) คืนเครดิตเต็มจำนวนอัตโนมัติ
 *     ถ้าบูสต์ไม่ครบ/ผู้ให้บริการคืนเครดิตร้านบางส่วน จะคืนเครดิตลูกค้าตามสัดส่วนเดียวกัน
 *     ถ้ายังไม่ทราบผลแน่ชัด (timeout/เชื่อมต่อไม่ได้) จะ "ไม่คืนเครดิตเอง" และบอกให้ติดต่อแอดมินพร้อม client_reference
 *
 * ต้องเรียกคู่กับ melodyBoost.js: เอา `service` ที่ setupMelodyBoost() คืนมา ส่งเป็น melodyService ที่นี่
 *
 * ENV ที่ต้องตั้งเพิ่ม:
 *   SLIPOK_API_KEY, SLIPOK_BRANCH_ID   — จาก SlipOK (ต้องตั้งค่าบัญชีผู้รับใน LINE LIFF dashboard ด้วย)
 *   CUSTOMER_PRICE_1M, CUSTOMER_PRICE_3M — ราคาขายต่อลูกบูสต์ (บาท) ดีฟอลต์ 9 / 24
 *   CUSTOMER_WALLET_FILE               — ไฟล์เก็บเครดิตลูกค้า ดีฟอลต์ customer_wallet.json
 *   BOOST_PROMPTPAY_NUMBER             — เลขพร้อมเพย์ที่ใช้แสดงให้ลูกค้าโอน (ใช้ตัวเดียวกับ melodyBoost.js ได้)
 *   BOOST_TRUEMONEY_NUMBER             — เบอร์ TrueMoney ของร้าน ใช้รับ "ซองของขวัญ (อังเปา)" ของลูกค้า
 *   BOOST_SHOP_BANNER_URL / BOOST_SHOP_THUMB_URL / BOOST_SHOP_FOOTER_ICON / BOOST_RAINBOW_BAR_URL — รูปตกแต่ง embed (ไม่บังคับ)
 *
 * โพสต์หน้าร้านด้วย !boostshop หรือ !customershop (เฉพาะแอดมิน)
 *
 * เติมเครดิต 2 ช่องทาง:
 *   💳 พร้อมเพย์ — เลือกยอด → โอน → แนบสลิป → ตรวจด้วย SlipOK → เติมอัตโนมัติ
 *   🧧 TrueMoney — กดปุ่ม → วางลิงก์ซองของขวัญ → บอทรับซองเข้าเบอร์ร้าน → เติมอัตโนมัติ
 */
const path = require('path');
const crypto = require('crypto');
const { WalletStore } = require('./wallet');
const { verifySlip } = require('./slipok');
const { promptPayQrPng } = require('./promptpayQr');
const { redeemVoucher, extractVoucherCode } = require('./truemoney');

const CUSTOMER_TIERS = ['1m', '3m'];
const TIER_LABEL = { '1m': '1 เดือน', '3m': '3 เดือน' };
const MAX_NICK_LENGTH = 32;
const NO_REFUND_FAILURE_REASONS = new Set(['join_failed', 'guild_not_found', 'kicked_after_join']);
const TOPUP_WAIT_MS = 3 * 60_000;
const TOPUP_PRESETS = [50, 100, 200, 300, 500, 1000];
const SHOP_FOOTER = '⇢ ˗ˏˋ ℂ𝕆𝕄𝔼𝕋 ℕ𝔼𝕎 ࿐ྂ';
// ห้องตรวจสลิป (ตรวจเฉพาะห้องนี้เท่านั้น) และห้องแสดงหน้าสรุปสถานะบูสต์
const SLIP_CHANNEL_ID = '1555927974455418900';
const STATUS_CHANNEL_ID = '1565009038733877369';
// แจ้งเตือนเมื่อสต็อกบูสต์ถึงเกณฑ์ (ปิง role ในห้องนี้)
const STOCK_ALERT_CHANNEL_ID = '1565691050608164994';
const STOCK_ALERT_ROLE_ID = '1555146265958944878';
const STOCK_ALERT_MIN = 150;
/** Custom emoji สำหรับ embed/ปุ่ม — อย่าใส่ใน modal title (ลิมิต Discord 45 ตัวอักษร) */
const EMOJI = {
  BOOST_AUTO: '<:1432612004434284626:1564569526492991569>',
  SPARKLE: '<a:1394253573344329778:1564675042829271060>',
  WARN: '<a:Warnflash:1561005772597493930>',
  PROMPTPAY: '<:1285430053815189596:1564674903922311218>',
  TRUEMONEY: '<:1395398692537761924:1564674762335195178>',
  PRICE: '<a:1393835504855679127:1565030940718145666>',
  MEALS: '<a:Meals:1557406252789792878>',
  TOPUP: '<a:1394253628729987074:1565030898917707967>',
  WALLET: '<:1398290306914320555:1564569543186186281>',
  PAY: '<a:1427603143377551381:1561657371288150086>',
  LOADING: '<a:Loading:1561005733577752586>',
  SUCCESS: '<a:99_1right_melody:1486114861787254874>',
};

// ---------- helpers ----------
function toNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function toInt(v) {
  const n = toNumber(v);
  return n === null ? null : Math.trunc(n);
}
const looksLikeInvite = (s) => /(discord\.gg\/|discord(app)?\.com\/invite\/)/i.test(s);

function validateOrderInput(server, tier, amount, nick = '') {
  const srv = typeof server === 'string' ? server.trim() : '';
  if (!srv) throw new Error('ต้องใส่ลิงก์เชิญเซิร์ฟเวอร์ Discord');
  if (/\s/.test(srv)) throw new Error('ลิงก์เชิญต้องไม่มีช่องว่าง');
  if (!looksLikeInvite(srv)) throw new Error('ลิงก์ที่ใส่ไม่เหมือนลิงก์เชิญ Discord เช่น https://discord.gg/xxxx');
  const t = typeof tier === 'string' ? tier.trim().toLowerCase() : '';
  if (!CUSTOMER_TIERS.includes(t)) throw new Error('แพ็กต้องเป็น 1m หรือ 3m เท่านั้น');
  let n = amount;
  if (typeof n === 'string') {
    if (!/^\d+$/.test(n.trim())) throw new Error('จำนวนบูสต์ต้องเป็นตัวเลขจำนวนเต็ม');
    n = parseInt(n.trim(), 10);
  }
  if (!Number.isInteger(n)) throw new Error('จำนวนบูสต์ต้องเป็นตัวเลขจำนวนเต็ม');
  if (n < 2) throw new Error('จำนวนบูสต์ต้องไม่น้อยกว่า 2');
  if (n % 2 !== 0) throw new Error('จำนวนบูสต์ต้องเป็นเลขคู่');
  const nk = typeof nick === 'string' ? nick.trim() : '';
  if (nk.length > MAX_NICK_LENGTH) throw new Error(`nick ยาวได้ไม่เกิน ${MAX_NICK_LENGTH} ตัวอักษร`);
  return { server: srv, tier: t, amount: n, nick: nk };
}

/**
 * @param discordClient discord.js Client (ต้องมี intents: Guilds, GuildMessages, MessageContent)
 * @param melodyService service ที่ได้จาก setupMelodyBoost() ใน melodyBoost.js
 * @param options { price1m?, price3m?, slipokApiKey?, slipokBranchId?, promptpayNumber?, truemoneyNumber?, shopBannerUrl?, shopThumbUrl?, shopFooterIconUrl?, rainbowBarUrl?, adminIds?, adminRoleIds? }
 */
function setupCustomerShop(discordClient, melodyService, options = {}) {
  const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    PermissionFlagsBits,
    AttachmentBuilder,
  } = require('discord.js');

  if (!melodyService) {
    console.error('[customer-shop] ปิดใช้งาน: ไม่ได้ส่ง melodyService (ผลลัพธ์จาก setupMelodyBoost) มาให้');
    return null;
  }

  const price1m = toNumber(options.price1m ?? process.env.CUSTOMER_PRICE_1M) ?? 9;
  const price3m = toNumber(options.price3m ?? process.env.CUSTOMER_PRICE_3M) ?? 24;
  const CUSTOMER_PRICE = { '1m': price1m, '3m': price3m };

  const slipokApiKey = (options.slipokApiKey || process.env.SLIPOK_API_KEY || '').trim();
  const slipokBranchId = (options.slipokBranchId || process.env.SLIPOK_BRANCH_ID || '').trim();
  if (!slipokApiKey || !slipokBranchId) {
    console.error('[customer-shop] คำเตือน: ไม่พบ SLIPOK_API_KEY/SLIPOK_BRANCH_ID — ปุ่มเติมเครดิตจะใช้งานไม่ได้จนกว่าจะตั้งค่า');
  }
  const promptpayNumber = (options.promptpayNumber || process.env.BOOST_PROMPTPAY_NUMBER || '').trim();
  const truemoneyNumber = (options.truemoneyNumber || process.env.BOOST_TRUEMONEY_NUMBER || '').trim();
  const cleanUrl = (name, value) => {
    const v = String(value || '').trim();
    if (!v) return null;
    try {
      const u = new URL(v);
      if (u.protocol === 'https:' || u.protocol === 'http:') return v;
    } catch {
      /* ไม่ใช่ URL */
    }
    console.warn(`[customer-shop] ข้าม ${name}: ไม่ใช่ลิงก์ http(s) ที่ถูกต้อง`);
    return null;
  };
  const shopBannerUrl = cleanUrl('BOOST_SHOP_BANNER_URL', options.shopBannerUrl || process.env.BOOST_SHOP_BANNER_URL);
  const shopThumbUrl = cleanUrl('BOOST_SHOP_THUMB_URL', options.shopThumbUrl || process.env.BOOST_SHOP_THUMB_URL);
  const shopFooterIconUrl = cleanUrl('BOOST_SHOP_FOOTER_ICON', options.shopFooterIconUrl || process.env.BOOST_SHOP_FOOTER_ICON);
  const rainbowBarUrl = cleanUrl('BOOST_RAINBOW_BAR_URL', options.rainbowBarUrl || process.env.BOOST_RAINBOW_BAR_URL);

  const adminIds = new Set(
    (options.adminIds || String(process.env.BOOST_ADMIN_IDS || '').split(','))
      .map((s) => String(s).trim())
      .filter(Boolean),
  );
  const adminRoleIds = new Set(
    (options.adminRoleIds || String(process.env.BOOST_ADMIN_ROLE_IDS || '').split(','))
      .map((s) => String(s).trim())
      .filter(Boolean),
  );
  const isAdmin = (member, userId) => {
    if (adminIds.has(userId)) return true;
    if (member && member.roles && adminRoleIds.size > 0) {
      if (member.roles.cache) return member.roles.cache.some((_, id) => adminRoleIds.has(id));
      if (Array.isArray(member.roles)) return member.roles.some((id) => adminRoleIds.has(id));
    }
    if (adminIds.size === 0 && adminRoleIds.size === 0) {
      return Boolean(member && member.permissions && member.permissions.has(PermissionFlagsBits.Administrator));
    }
    return false;
  };

  const walletFile = path.resolve((process.env.CUSTOMER_WALLET_FILE || '').trim() || 'customer_wallet.json');
  const wallet = new WalletStore(walletFile);
  // mutex ง่าย ๆ กันเขียนไฟล์ชนกันตอนมีหลายคำสั่งเข้ามาพร้อมกัน
  let walletChain = Promise.resolve();
  const withWalletLock = (fn) => {
    const run = walletChain.then(fn);
    walletChain = run.catch(() => {});
    return run;
  };
  // เติมเครดิตแบบลองซ้ำ (กันดิสก์สะดุดชั่วคราว) — ถ้า transRef ซ้ำจะไม่ลองใหม่
  const creditWithRetry = async (uid, amt, meta, tries = 3) => {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        return await withWalletLock(() => wallet.credit(uid, amt, meta));
      } catch (e) {
        last = e;
        if (e && e.code === 'DUPLICATE_REF') throw e;
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
    throw last;
  };
  const bootTime = new Date().toISOString(); // รายการที่เกิดก่อนเวลานี้ = ค้างจากรอบก่อนที่บอทดับ
  try {
    wallet.selfCheck(); // เช็ค/กู้ไฟล์กระเป๋าตั้งแต่ตอนเริ่ม
  } catch (e) {
    console.error(`[customer-shop] 🚨 ไฟล์กระเป๋าเครดิตมีปัญหา: ${e.message} — ห้ามลบ/เขียนทับไฟล์ ให้ตรวจ/กู้ก่อน`);
  }

  const logChannelId = (options.logChannelId || process.env.BOOST_LOG_CHANNEL_ID || '').trim() || null;

  const fmtBaht = (v) => `${Number(v).toLocaleString('th-TH')} บาท`;
  const pendingTopups = new Map(); // userId -> { amount, expiresAt }
  const slipChannelId = SLIP_CHANNEL_ID;
  const statusChannelId = (options.statusChannelId || process.env.BOOST_STATUS_CHANNEL_ID || '').trim() || STATUS_CHANNEL_ID;

  // ---------- หน้าสรุปสถานะบูสต์ (ขึ้นห้องสถานะ ไม่โชว์ข้อมูลเทคนิค/เลขออเดอร์) ----------
  const mono = (v) => `\`${String(v ?? '-').replace(/`/g, "'")}\``;
  function buildStatusEmbed({ username, tier, requested, guildName, guildIcon, state, applied = null, before = null, after = null }) {
    const colors = { processing: 0xfee75c, completed: 0x57f287, partial: 0xe67e22, failed: 0xed4245, review: 0x3498db };
    const done = applied ?? 0;
    const statusText = {
      processing: `กำลังบูสต์ ${done} | ${requested} บูสต์`,
      completed: `สำเร็จ ${done} | ${requested} บูสต์`,
      partial: `สำเร็จบางส่วน ${done} | ${requested} บูสต์`,
      failed: `ไม่สำเร็จ ${done} | ${requested} บูสต์`,
      review: 'รอแอดมินตรวจสอบ',
    }[state];
    let boostLine;
    if (state === 'processing') boostLine = 'กำลังดำเนินการ...';
    else if (state === 'review') boostLine = 'รอตรวจสอบ';
    else boostLine = before !== null && after !== null ? `เพิ่ม ${done} (ก่อน ${before} | หลัง ${after})` : `เพิ่ม ${done}`;
    const embed = new EmbedBuilder()
      .setColor(colors[state] || 0x5865f2)
      .setDescription(
        [
          `### ── ○ • ${mono('  STATUS BOOST  ')}`,
          '',
          `• **ผู้ใช้ :** ${mono(username)}`,
          `• **ประเภทบูสต์ :** ${mono(`${TIER_LABEL[tier] || tier} | ${requested} บูสต์`)}`,
          `• **บูสต์เซิร์ฟเวอร์ :** ${mono(boostLine)}`,
          '',
          `• **เซิร์ฟเวอร์ :** ${mono(guildName || 'ไม่ทราบ')}`,
          `• **สถานะบูสต์ :** ${mono(statusText)}`,
        ].join('\n'),
      )
      .setFooter({ text: SHOP_FOOTER, iconURL: shopFooterIconUrl || undefined });
    const thumb = guildIcon || shopThumbUrl;
    if (thumb) embed.setThumbnail(thumb);
    if (rainbowBarUrl) embed.setImage(rainbowBarUrl);
    return embed;
  }
  async function resolveInviteGuild(server) {
    const m = String(server).match(/(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]+)/i);
    if (!m) return { name: null, icon: null };
    try {
      const inv = await Promise.race([
        discordClient.fetchInvite(m[1]),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]);
      const g = inv && inv.guild;
      return {
        name: (g && g.name) || null,
        icon: g && typeof g.iconURL === 'function' ? g.iconURL({ extension: 'png', size: 256 }) : null,
      };
    } catch {
      return { name: null, icon: null };
    }
  }
  async function postStatus(payload) {
    try {
      const ch = await discordClient.channels.fetch(statusChannelId);
      if (ch && ch.isTextBased()) return await ch.send({ ...payload, allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('[customer-shop] ส่งหน้าสถานะไม่ได้:', err && err.message);
    }
    return null;
  }
  // แจ้งแอดมินที่ห้อง log (รายละเอียดเทคนิคอยู่ที่นี่ ไม่ส่งให้ลูกค้า)
  async function notifyAdmins(color, title, lines, fields = []) {
    if (!logChannelId || logChannelId === statusChannelId) return;
    try {
      const ch = await discordClient.channels.fetch(logChannelId).catch(() => null);
      if (!ch || !ch.isTextBased()) return;
      const e = new EmbedBuilder().setColor(color).setDescription([`# ${title}`, ...lines].join('\n')).setFooter({ text: SHOP_FOOTER }).setTimestamp();
      if (fields.length) e.addFields(fields);
      await ch.send({ embeds: [e], allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('[customer-shop] ส่ง log ไม่ได้:', err && err.message);
    }
  }
  // ---------- log การเติมเครดิต: ใคร เติมอะไร เท่าไหร่ ----------
  const topupLogChannelId =
    (options.topupLogChannelId || process.env.BOOST_TOPUP_LOG_CHANNEL_ID || '').trim() || '1565973316487872512';
  const TOPUP_SOURCE_LABEL = { truemoney: '🧧 TrueMoney (ซองของขวัญ)', slipok: '💳 พร้อมเพย์ (สลิป)', admin: '🛠️ แอดมินเติมให้' };
  async function logTopup({ userId, amount, balance, source, from, by, note, transRef, recovered = false }) {
    try {
      const ch = await discordClient.channels.fetch(topupLogChannelId).catch(() => null);
      if (!ch || !ch.isTextBased()) {
        console.error(`[customer-shop] ส่ง log เติมเครดิตไม่ได้: ไม่พบห้อง ${topupLogChannelId} หรือบอทไม่มีสิทธิ์`);
        return;
      }
      let uname = '';
      try {
        const u = await discordClient.users.fetch(userId);
        uname = u && u.username ? u.username : '';
      } catch { /* ใช้แค่ mention */ }
      const lines = [
        `# 💰 เติมเครดิต${recovered ? ' (กู้หลังบอทเริ่มใหม่)' : ''}`,
        `**ลูกค้า:** <@${userId}>${uname ? ` (${uname})` : ''} \`${userId}\``,
        `**ช่องทาง:** ${TOPUP_SOURCE_LABEL[source] || source}`,
        `**จำนวนที่เติม:** +${fmtBaht(amount)}`,
        balance != null ? `**เครดิตคงเหลือ:** ${fmtBaht(balance)}` : '',
        from && from !== 'ไม่ทราบ' ? `**เจ้าของซอง:** ${from}` : '',
        by ? `**ผู้เติม:** <@${by}>` : '',
        note ? `**หมายเหตุ:** ${note}` : '',
        transRef ? `**อ้างอิง:** \`${transRef}\`` : '',
      ].filter(Boolean);
      const e = new EmbedBuilder().setColor(0x57f287).setDescription(lines.join('\n')).setFooter({ text: SHOP_FOOTER }).setTimestamp();
      await ch.send({ embeds: [e], allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('[customer-shop] ส่ง log เติมเครดิตไม่ได้:', err && err.message);
    }
  }
  // ข้อความ error ที่ลูกค้าเห็นได้ — ตัดคำเทคนิค/ชื่อผู้ให้บริการออก
  const TECH_RE = /client_reference|boosttrack|boostfind|boostpending|\bapi\b|api_|order_id|price_charged|refunded|stock_conflict|token|melody/i;
  function safeErr(err) {
    const m = (err && err.message) || '';
    if (!m || TECH_RE.test(m)) {
      console.error('[customer-shop] ซ่อน error จากลูกค้า:', m);
      return 'ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้ง หรือติดต่อแอดมิน';
    }
    return m;
  }

  // ---------- หน้าร้าน (Embed ใหญ่ + dropdown + ปุ่มยาว กดง่าย) ----------
  const block = (text) => `\`\`\`${text}\`\`\``;
  const withUnit = (v, unit) => (v === null || v === undefined ? 'ไม่ทราบ' : `${Number(v).toLocaleString('th-TH')} ${unit}`);

  async function fetchStock() {
    try {
      const stock = await melodyService.client.stock();
      return stock && typeof stock === 'object' ? stock : {};
    } catch (err) {
      console.error('[customer-shop] ดึงสต็อกไม่ได้:', err && err.message);
      return {};
    }
  }

  // จำนวนบูสต์ที่บอทบูสต์สำเร็จจริงทั้งหมด แยกตามแพ็ก (รวมจากประวัติออเดอร์ที่จบแล้ว)
  function countBoostedTotals() {
    if (typeof melodyService.list !== 'function') return null;
    try {
      const totals = { '1m': 0, '3m': 0 };
      for (const r of melodyService.list()) {
        if (r.state !== 'final' || !r.last_snapshot || !(r.tier in totals)) continue;
        const n = toInt(r.last_snapshot.boosts_applied);
        if (n !== null && n > 0) totals[r.tier] += n;
      }
      return totals;
    } catch (err) {
      console.error('[customer-shop] นับบูสต์ทั้งหมดไม่ได้:', err && err.message);
      return null;
    }
  }

  async function buildShopPayload(preloadedStock) {
    const stock = preloadedStock || (await fetchStock());
    const boostedTotals = countBoostedTotals();
    const info = {};
    for (const t of CUSTOMER_TIERS) {
      info[t] = {
        left: toInt(stock[`boosts_${t}_available`]),
        total: boostedTotals ? boostedTotals[t] : toInt(stock[`boosts_${t}_total`]),
      };
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setDescription(
        [
          `# ${EMOJI.BOOST_AUTO}  BOOST - AUTO`,
          `### ${EMOJI.SPARKLE}  Boost Discord Server Auto ${EMOJI.SPARKLE}`,
          '',
          `## ${EMOJI.WARN}  อ่านก่อนสั่งซื้อ  ${EMOJI.WARN}`,
          
          '<#1565033235757404381>',
          '',
          `${EMOJI.PROMPTPAY}  **พร้อมเพย์**   | ${EMOJI.TRUEMONEY}  **TrueMoney**`,
          '',
          `${EMOJI.PRICE}   **บูสต์ ${TIER_LABEL['1m']}** — ${fmtBaht(CUSTOMER_PRICE['1m'])} / บูสต์`,
          `${EMOJI.PRICE}   **บูสต์ ${TIER_LABEL['3m']}** — ${fmtBaht(CUSTOMER_PRICE['3m'])} / บูสต์`,
        ].join('\n'),
      );
    for (const t of CUSTOMER_TIERS) {
      embed.addFields(
        { name: `${EMOJI.MEALS} บูสต์ ${TIER_LABEL[t]}`, value: block(`${fmtBaht(CUSTOMER_PRICE[t])} / บูสต์`), inline: true },
        { name: '⌛ เหลือจำนวน', value: block(withUnit(info[t].left, 'บูสต์')), inline: true },
        { name: '📦 บูสต์แล้วทั้งหมด', value: block(withUnit(info[t].total, 'บูสต์')), inline: true },
      );
    }
    if (shopBannerUrl) embed.setImage(shopBannerUrl);
    if (shopThumbUrl) embed.setThumbnail(shopThumbUrl);
    const footer = { text: SHOP_FOOTER };
    if (shopFooterIconUrl) footer.iconURL = shopFooterIconUrl;
    embed.setFooter(footer);

    const select = new StringSelectMenuBuilder()
      .setCustomId('cs:tier')
      .setPlaceholder('📦 เลือกแพ็กบูสต์')
      .addOptions(
        CUSTOMER_TIERS.map((t) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`บูสต์เซิร์ฟเวอร์ ${TIER_LABEL[t]}`)
            .setDescription(`ราคา ${fmtBaht(CUSTOMER_PRICE[t])} / บูสต์ | คงเหลือ ${info[t].left ?? 'ไม่ทราบ'}`)
            .setValue(t)
            .setEmoji(EMOJI.MEALS),
        ),
      );
    // ปุ่มเติมเงิน + เช็คยอด อยู่แถวเดียวกัน
    const rowActions = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('cs:topup')
        .setLabel('เติมเงิน')
        .setStyle(ButtonStyle.Success)
        .setEmoji(EMOJI.TOPUP),
      new ButtonBuilder()
        .setCustomId('cs:balance')
        .setLabel('เช็คยอดเงิน')
        .setStyle(ButtonStyle.Primary)
        .setEmoji(EMOJI.WALLET),
    );
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), rowActions] };
  }
  async function postShop(channel) {
    const sent = await channel.send(await buildShopPayload());
    registerShopMessage(channel.id, sent.id);
    return sent;
  }

  // ---------- อัปเดตหน้าร้านอัตโนมัติ (สต็อกเปลี่ยน / มีคนบูสต์เสร็จ) ----------
  const shopMsgFile = path.join(path.dirname(walletFile), 'shop_messages.json');
  let shopMessages = [];
  try {
    const raw = JSON.parse(require('fs').readFileSync(shopMsgFile, 'utf8'));
    if (Array.isArray(raw)) shopMessages = raw.filter((x) => x && x.channelId && x.messageId);
  } catch {
    /* ยังไม่มีไฟล์ = ยังไม่เคยโพสต์หน้าร้าน */
  }
  function saveShopMessages() {
    try {
      const fs = require('fs');
      const tmp = `${shopMsgFile}.tmp`;
      fs.mkdirSync(path.dirname(shopMsgFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(shopMessages, null, 2));
      fs.renameSync(tmp, shopMsgFile);
    } catch (err) {
      console.error('[customer-shop] บันทึกรายการหน้าร้านไม่ได้:', err && err.message);
    }
  }
  function registerShopMessage(channelId, messageId) {
    if (!shopMessages.some((x) => x.messageId === messageId)) {
      shopMessages.push({ channelId, messageId });
      if (shopMessages.length > 20) shopMessages = shopMessages.slice(-20);
      saveShopMessages();
    }
    lastShopSig = null; // บังคับให้รอบถัดไปเทียบใหม่
  }

  // แคชผลสต็อกช่วงสั้น ๆ ให้ระบบอัปเดตหน้าร้านกับระบบแจ้งเตือนใช้ร่วมกัน (ลดจำนวนคำขอ)
  let stockCache = { at: 0, data: null };
  async function getStockCached(maxAgeMs = 20_000) {
    if (stockCache.data && Date.now() - stockCache.at < maxAgeMs) return stockCache.data;
    const data = await melodyService.client.stock();
    stockCache = { at: Date.now(), data };
    return data;
  }

  let lastShopSig = null;
  let refreshingShop = false;
  async function refreshShops(reason) {
    if (refreshingShop || shopMessages.length === 0) return;
    refreshingShop = true;
    try {
      let stock;
      try {
        stock = await getStockCached(5000);
      } catch (err) {
        console.error('[customer-shop] อัปเดตหน้าร้าน: ดึงสต็อกไม่ได้:', err && err.message);
        return; // ดึงไม่ได้ = ไม่แก้ข้อความ (กันขึ้น "ไม่ทราบ")
      }
      if (!stock || typeof stock !== 'object') return;
      const totals = countBoostedTotals();
      const sig = JSON.stringify([
        CUSTOMER_TIERS.map((t) => [toInt(stock[`boosts_${t}_available`]), toInt(stock[`boosts_${t}_total`])]),
        totals,
        CUSTOMER_PRICE,
      ]);
      if (sig === lastShopSig) return; // ไม่มีอะไรเปลี่ยน ไม่ต้องแก้ข้อความ
      const payload = await buildShopPayload(stock);
      let allOk = true;
      for (const entry of [...shopMessages]) {
        try {
          const ch = await discordClient.channels.fetch(entry.channelId);
          await ch.messages.edit(entry.messageId, payload);
        } catch (err) {
          const code = err && err.code;
          if (code === 10008 || code === 10003 || code === 50001) {
            // ข้อความ/ห้องถูกลบ หรือบอทเข้าไม่ได้ -> เลิกอัปเดตอันนี้
            shopMessages = shopMessages.filter((x) => x.messageId !== entry.messageId);
            saveShopMessages();
          } else {
            allOk = false;
            console.error('[customer-shop] แก้หน้าร้านไม่ได้:', err && err.message);
          }
        }
      }
      if (allOk) lastShopSig = sig;
      if (reason) console.log(`[customer-shop] อัปเดตหน้าร้านแล้ว (${reason})`);
    } finally {
      refreshingShop = false;
    }
  }
  const shopRefreshSec = Math.max(30, toInt(process.env.BOOST_SHOP_REFRESH_SEC) ?? 60);
  let shopTimerStarted = false;
  function startShopRefresh() {
    if (shopTimerStarted) return;
    shopTimerStarted = true;
    const timer = setInterval(() => refreshShops('สต็อก/ยอดบูสต์เปลี่ยน').catch(() => {}), shopRefreshSec * 1000);
    if (timer.unref) timer.unref();
    refreshShops().catch(() => {}); // เทียบครั้งแรกทันทีหลังบอทออนไลน์
  }
  if (typeof discordClient.isReady === 'function' && discordClient.isReady()) startShopRefresh();
  else {
    discordClient.once('ready', startShopRefresh);
    discordClient.once('clientReady', startShopRefresh);
  }

  // ---------- แจ้งเตือนเมื่อสต็อกบูสต์ถึงเกณฑ์ (ครั้งเดียวต่อรอบที่สต็อกขึ้นไปถึง/เกินเกณฑ์) ----------
  const alertStateFile = path.join(path.dirname(walletFile), 'stock_alert_state.json');
  let alertState = { '1m': false, '3m': false };
  try {
    const raw = JSON.parse(require('fs').readFileSync(alertStateFile, 'utf8'));
    for (const t of CUSTOMER_TIERS) alertState[t] = Boolean(raw && raw[t]);
  } catch {
    /* ยังไม่มีไฟล์ = ยังไม่เคยแจ้ง */
  }
  function saveAlertState() {
    try {
      const fs = require('fs');
      const tmp = `${alertStateFile}.tmp`;
      fs.mkdirSync(path.dirname(alertStateFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(alertState, null, 2));
      fs.renameSync(tmp, alertStateFile);
    } catch (err) {
      console.error('[customer-shop] บันทึกสถานะแจ้งเตือนสต็อกไม่ได้:', err && err.message);
    }
  }
  let checkingAlert = false;
  async function checkStockAlert() {
    if (checkingAlert) return;
    checkingAlert = true;
    try {
      let stock;
      try {
        stock = await getStockCached(20_000);
      } catch (err) {
        console.error('[customer-shop] เช็กสต็อกเพื่อแจ้งเตือนไม่ได้:', err && err.message);
        return;
      }
      if (!stock || typeof stock !== 'object') return;
      const counts = {};
      const newly = [];
      let changed = false;
      for (const t of CUSTOMER_TIERS) {
        const n = toInt(stock[`boosts_${t}_available`]);
        counts[t] = n;
        if (n === null) continue; // ไม่รู้ค่า = ไม่เปลี่ยนสถานะ
        if (n >= STOCK_ALERT_MIN) {
          if (!alertState[t]) {
            alertState[t] = true;
            newly.push(t);
            changed = true;
          }
        } else if (alertState[t]) {
          alertState[t] = false; // สต็อกลดต่ำกว่าเกณฑ์แล้ว รอบหน้าที่กลับขึ้นไปค่อยแจ้งใหม่
          changed = true;
        }
      }
      if (newly.length === 0) {
        if (changed) saveAlertState();
        return;
      }
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setDescription(
          [
            '# 📦 สต็อกบูสต์เติมแล้ว',
            `สต็อกถึง **${STOCK_ALERT_MIN}** บูสต์ขึ้นไปแล้ว พร้อมเปิดขาย`,
            '',
            ...CUSTOMER_TIERS.map(
              (t) => `• **บูสต์ ${TIER_LABEL[t]} :** ${mono(counts[t] === null ? 'ไม่ทราบ' : `${counts[t].toLocaleString('th-TH')} บูสต์`)}${newly.includes(t) ? ' ✅' : ''}`,
            ),
          ].join('\n'),
        )
        .setFooter({ text: SHOP_FOOTER, iconURL: shopFooterIconUrl || undefined })
        .setTimestamp();
      try {
        const ch = await discordClient.channels.fetch(STOCK_ALERT_CHANNEL_ID);
        if (!ch || !ch.isTextBased()) throw new Error('ห้องแจ้งเตือนสต็อกไม่ใช่ห้องข้อความ');
        await ch.send({
          content: `<@&${STOCK_ALERT_ROLE_ID}>`,
          embeds: [embed],
          allowedMentions: { roles: [STOCK_ALERT_ROLE_ID] },
        });
        saveAlertState();
      } catch (err) {
        // ส่งไม่สำเร็จ -> คืนสถานะ ให้ลองใหม่รอบถัดไป
        for (const t of newly) alertState[t] = false;
        console.error('[customer-shop] ส่งแจ้งเตือนสต็อกไม่ได้:', err && err.message);
      }
    } finally {
      checkingAlert = false;
    }
  }
  function startStockAlert() {
    const timer = setInterval(() => checkStockAlert().catch(() => {}), shopRefreshSec * 1000);
    if (timer.unref) timer.unref();
    checkStockAlert().catch(() => {});
  }
  if (typeof discordClient.isReady === 'function' && discordClient.isReady()) startStockAlert();
  else {
    let alertStarted = false;
    const once = () => {
      if (alertStarted) return;
      alertStarted = true;
      startStockAlert();
    };
    discordClient.once('ready', once);
    discordClient.once('clientReady', once);
  }

  // ---------- โพสต์หน้าร้าน (เฉพาะแอดมิน) ----------
  discordClient.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const text = message.content.trim().toLowerCase();
    if (text !== '!customershop' && text !== '!boostshop') return;
    if (!isAdmin(message.member, message.author.id)) return;
    await postShop(message.channel).catch((e) => console.error('[customer-shop] postShop error:', e && e.message));
    message.delete().catch(() => {}); // ลบข้อความคำสั่ง (ต้องมีสิทธิ์ Manage Messages ถ้าไม่มีจะข้าม)
  });

  // ---------- แอดมินเติมเครดิตให้ลูกค้าเอง: !addcredit @คน 100 [หมายเหตุ] ----------
  discordClient.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;
      if (!/^!(addcredit|เติมเครดิต)(\s|$)/i.test(message.content.trim())) return;
      if (!isAdmin(message.member, message.author.id)) return;
      const m = message.content.trim().match(/^!(addcredit|เติมเครดิต)\s+(?:<@!?(\d{15,25})>|(\d{15,25}))\s+([\d,]+(?:\.\d{1,2})?)(?:\s+([\s\S]+))?$/i);
      if (!m) {
        await message.reply('⚠️ ใช้แบบนี้: `!addcredit @ลูกค้า 100 หมายเหตุ(ไม่ใส่ก็ได้)` หรือใช้ไอดีแทน @ ก็ได้').catch(() => {});
        return;
      }
      const targetId = m[2] || m[3];
      const amount = Math.round(Number(m[4].replace(/,/g, '')) * 100) / 100;
      const note = (m[5] || '').trim().slice(0, 200);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
        await message.reply('⚠️ จำนวนเงินไม่ถูกต้อง (ต้องมากกว่า 0 และไม่เกิน 100,000)').catch(() => {});
        return;
      }
      let newBalance;
      try {
        newBalance = await withWalletLock(() =>
          wallet.credit(targetId, amount, { source: 'admin', by: message.author.id, note: note || undefined }),
        );
      } catch (err) {
        await message.reply(`⚠️ เติมเครดิตไม่สำเร็จ: ${err.message}`).catch(() => {});
        return;
      }
      await message
        .reply({
          content: `✅ เติมเครดิตให้ <@${targetId}> **+${fmtBaht(amount)}** แล้ว (คงเหลือ: **${fmtBaht(newBalance)}**)${note ? `\nหมายเหตุ: ${note}` : ''}`,
          allowedMentions: { parse: [], repliedUser: false },
        })
        .catch(() => {});
      logTopup({ userId: targetId, amount, balance: newBalance, source: 'admin', by: message.author.id, note });
      await notifyAdmins(0x3498db, '🛠️ แอดมินเติมเครดิต', [
        `**ผู้เติม:** <@${message.author.id}>`,
        `**ผู้รับ:** <@${targetId}>`,
        `**จำนวน:** ${fmtBaht(amount)} (คงเหลือ ${fmtBaht(newBalance)})`,
        note ? `**หมายเหตุ:** ${note}` : '',
      ].filter(Boolean));
    } catch (err) {
      console.error('[customer-shop] addcredit error:', err);
    }
  });

  // ---------- เติมเครดิต: เลือกช่องทาง ----------
  const slipReady = Boolean(slipokApiKey && slipokBranchId);
  const truemoneyReady = Boolean(truemoneyNumber);

  function payMenuPayload() {
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setDescription(
        [
          `# ${EMOJI.PAY}  เลือกช่องทางเติมเงิน`,
          `## ${EMOJI.PROMPTPAY} พร้อมเพย์`,
          `## ${EMOJI.TRUEMONEY} TrueMoney Wallet`,
        ].join('\n'),
      );
    if (rainbowBarUrl) embed.setImage(rainbowBarUrl);
    const rows = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('cs:pay:promptpay')
          .setLabel('พร้อมเพย์')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('💳'),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('cs:pay:truemoney')
          .setLabel('TrueMoney  (ส่งซองของขวัญ)')
          .setStyle(ButtonStyle.Success)
          .setEmoji(EMOJI.TRUEMONEY),
      ),
    ];
    return { content: '', embeds: [embed], components: rows };
  }

  // ---------- เติมเครดิต: พร้อมเพย์ (SlipOK) ----------
  function amountPickerPayload() {
    const embed = new EmbedBuilder()
      .setColor(0x1e88e5)
      .setDescription(
        [
          `# ${EMOJI.PROMPTPAY} เติมเครดิตด้วยพร้อมเพย์`,
          '## เลือกยอดที่ต้องการเติม',
          'กดปุ่มจำนวนเงินด้านล่าง หรือกด **✏️ ระบุจำนวนเอง**',
          '*ระบบตรวจสลิปอัตโนมัติด้วย SlipOK*',
        ].join('\n'),
      );
    const presetButtons = TOPUP_PRESETS.map((n) =>
      new ButtonBuilder().setCustomId(`cs:amt:${n}`).setLabel(`${n.toLocaleString('th-TH')} บาท`).setStyle(ButtonStyle.Primary).setEmoji('💵'),
    );
    const rows = [
      new ActionRowBuilder().addComponents(presetButtons.slice(0, 3)),
      new ActionRowBuilder().addComponents(presetButtons.slice(3, 6)),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cs:amt:custom').setLabel('ระบุจำนวนเอง').setStyle(ButtonStyle.Success).setEmoji('✏️'),
        new ButtonBuilder().setCustomId('cs:pay:menu').setLabel('ย้อนกลับ').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
      ),
    ];
    return { content: '', embeds: [embed], components: rows };
  }

  function topupAmountModal() {
    return new ModalBuilder()
      .setCustomId('cs:topupmodal')
      .setTitle('💳 เติมเครดิต — ระบุจำนวนเงิน')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('amount')
            .setLabel('จำนวนเงินที่จะโอน (บาท)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('เช่น 100')
            .setRequired(true)
            .setMaxLength(10),
        ),
      );
  }

  function startTopup(userId, amount) {
    pendingTopups.set(userId, { amount, expiresAt: Date.now() + TOPUP_WAIT_MS });
    setTimeout(() => {
      const p = pendingTopups.get(userId);
      if (p && p.expiresAt <= Date.now()) pendingTopups.delete(userId);
    }, TOPUP_WAIT_MS + 2000).unref();
  }

  async function transferPayload(amount) {
    // สร้าง QR พร้อมเพย์ล็อกยอด (ถ้าสร้างไม่ได้ จะถอยกลับไปแสดงเลขพร้อมเพย์เฉย ๆ)
    let files = [];
    let qrOk = false;
    if (promptpayNumber) {
      try {
        const png = await promptPayQrPng(promptpayNumber, amount);
        files = [new AttachmentBuilder(png, { name: 'promptpay-qr.png' })];
        qrOk = true;
      } catch (err) {
        console.error('[customer-shop] สร้าง QR พร้อมเพย์ไม่สำเร็จ:', err.message);
      }
    }
    const embed = new EmbedBuilder()
      .setColor(0x1e88e5)
      .setDescription(
        [
          '# 💳 โอนเงินผ่านพร้อมเพย์',
          qrOk ? '## 1️⃣ สแกน QR ด้านล่าง (ยอดถูกล็อกให้แล้ว)' : '## 1️⃣ โอนเงินให้ตรงยอดเป๊ะ',
          `## 2️⃣ แนบรูปสลิปส่งในห้องนี้ <#${slipChannelId}> ภายใน 3 นาที`,
          '## 3️⃣ ระบบตรวจสลิปด้วย SlipOK แล้วเติมเครดิตให้เอง',
        ].join('\n'),
      )
      .addFields(
        { name: '💵 ยอดที่ต้องโอน', value: block(fmtBaht(amount)), inline: true },
        { name: '🏦 พร้อมเพย์', value: block(promptpayNumber || 'ยังไม่ได้ตั้งค่า — ติดต่อแอดมิน'), inline: true },
      )
      .setFooter({ text: 'ยอดในสลิปต้องตรงกับที่เลือกไว้พอดี | สลิปใช้ซ้ำไม่ได้' });
    if (qrOk) embed.setImage('attachment://promptpay-qr.png');
    else if (rainbowBarUrl) embed.setImage(rainbowBarUrl);
    return { content: '', embeds: [embed], components: [], files };
  }

  // ---------- เติมเครดิต: TrueMoney ซองของขวัญ ----------
  const redeemingNow = new Set(); // กันกดส่งโค้ดเดิมซ้ำพร้อมกัน
  function truemoneyModal() {
    return new ModalBuilder()
      .setCustomId('cs:tmmodal')
      .setTitle('🧧 เติมเครดิตด้วยซองทรูมันนี่')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('link')
            .setLabel('วางลิงก์ซองของขวัญ (อังเปา) ที่นี่')
            .setStyle(TextInputStyle.Paragraph) // กล่องสูง วางลิงก์ยาวได้สบาย
            .setPlaceholder('https://gift.truemoney.com/campaign/?v=xxxxxxxxxxxxxxxx')
            .setRequired(true)
            .setMinLength(10)
            .setMaxLength(300),
        ),
      );
  }

  async function handleTruemoneySubmit(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const userId = interaction.user.id;
    const code = extractVoucherCode(interaction.fields.getTextInputValue('link'));
    if (!code) {
      await interaction.editReply('⚠️ ลิงก์ไม่ถูกต้อง ต้องเป็นลิงก์ซองของขวัญ เช่น `https://gift.truemoney.com/campaign/?v=xxxx`');
      return;
    }
    if (redeemingNow.has(code)) {
      await interaction.editReply('⏳ ซองนี้กำลังถูกตรวจสอบอยู่ รอสักครู่ อย่ากดซ้ำ');
      return;
    }
    redeemingNow.add(code);
    const inflightId = `tm:${code}`;
    try {
      // จดลงสมุดก่อนรับซองเสมอ — ถ้าจดไม่ได้จะไม่รับซอง (ซองลูกค้ายังไม่ถูกใช้)
      try {
        await withWalletLock(() => wallet.beginInflight(inflightId, { kind: 'truemoney', userId, code }));
      } catch (err) {
        console.error('[customer-shop] จดสมุดก่อนรับซองไม่ได้:', err.message);
        await interaction.editReply('⚠️ ระบบบันทึกข้อมูลขัดข้อง ซองของคุณยังไม่ถูกใช้ ลองใหม่อีกครั้ง หรือติดต่อแอดมิน');
        return;
      }
      let voucher;
      try {
        voucher = await redeemVoucher({ code, phone: truemoneyNumber });
      } catch (err) {
        // ถึงตรงนี้ = ไม่ได้เงินเข้า (หรือไม่แน่ใจ) ปิดรายการค้าง; กรณีไม่แน่ใจให้แจ้งแอดมินพร้อมโค้ดซองไว้ตรวจ
        if (err.uncertain) {
          await notifyAdmins(0xe67e22, '⚠️ รับซอง TrueMoney: ผลไม่แน่ชัด (ต้องตรวจมือ)', [
            `**ลูกค้า:** <@${userId}>`,
            `**โค้ดซอง:** \`${code}\``,
            `**รายละเอียด:** ${err.message}`,
            'ถ้าเงินเข้า TrueMoney ร้านแล้ว ให้เติมให้ด้วย `!addcredit`',
          ]);
        }
        await withWalletLock(() => wallet.endInflight(inflightId)).catch(() => {});
        if (err.blocked) {
          // โดน Cloudflare บล็อกก่อนถึงตัวซอง — ซองยังไม่ถูกใช้ แจ้งแอดมินผ่าน log
          console.error(`[customer-shop] ⚠️ TrueMoney บล็อกบอท (HTTP ${err.httpStatus}) — ตั้ง TRUEMONEY_PROXY (proxy ไทย) หรือย้ายเซิร์ฟเวอร์ user=${userId}`);
          await interaction.editReply(`⚠️ ${err.message}`);
        } else if (err.uncertain) {
          // ไม่รู้ว่าเงินเข้าหรือยัง — ห้ามบอกว่าซองใช้ไม่ได้ และห้ามเติมเอง
          console.error(`[customer-shop] truemoney ผลไม่แน่ชัด user=${userId} code=${code}:`, err.message);
          await interaction.editReply(
            `🕒 ยังไม่ทราบผลการรับซอง (${err.message})\nถ้าเงินถูกตัดจากซองแล้วแต่เครดิตไม่เข้า ติดต่อแอดมินพร้อมลิงก์ซองนี้`,
          );
        } else {
          await interaction.editReply(`⚠️ ${err.message}`);
        }
        return;
      }

      // จดยอดที่ได้จริงลงสมุดทันที — ถ้าบอทดับก่อนเติมเครดิต เปิดใหม่จะเติมให้อัตโนมัติ
      await withWalletLock(() =>
        wallet.patchInflight(inflightId, { status: 'redeemed', amount: voucher.amount, ownerName: voucher.ownerName }),
      ).catch((e) => console.error('[customer-shop] จดยอดซองลงสมุดไม่ได้:', e.message));

      let newBalance;
      try {
        newBalance = await creditWithRetry(userId, voucher.amount, {
          transRef: `truemoney:${code}`,
          source: 'truemoney',
          from: voucher.ownerName,
          inflightId,
        });
      } catch (err) {
        console.error(`[customer-shop] ⚠️ รับซองแล้วแต่เติมเครดิตพลาด user=${userId} amount=${voucher.amount} code=${code}:`, err.message);
        if (err.code === 'DUPLICATE_REF') {
          await withWalletLock(() => wallet.endInflight(inflightId)).catch(() => {});
        } else {
          await notifyAdmins(0xed4245, '🚨 รับซองแล้วแต่เติมเครดิตไม่สำเร็จ', [
            `**ลูกค้า:** <@${userId}>`,
            `**ยอด:** ${fmtBaht(voucher.amount)}`,
            `**โค้ดซอง:** \`${code}\``,
            `**สาเหตุ:** ${err.message}`,
            'รายการถูกจดไว้แล้ว บอทจะเติมให้อัตโนมัติเมื่อเริ่มทำงานใหม่ (หรือเติมเองด้วย `!addcredit`)',
          ]);
        }
        await interaction.editReply(
          `⚠️ รับซองสำเร็จ ${fmtBaht(voucher.amount)} แต่เติมเครดิตไม่สำเร็จ (${err.message}) — ระบบบันทึกรายการไว้แล้ว ติดต่อแอดมินพร้อมลิงก์ซองนี้`,
        );
        return;
      }

      logTopup({ userId, amount: voucher.amount, balance: newBalance, source: 'truemoney', from: voucher.ownerName, transRef: `truemoney:${code}` });
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setDescription(['# ✅ เติมเครดิตสำเร็จ', `## +${fmtBaht(voucher.amount)}`, `เครดิตคงเหลือ: **${fmtBaht(newBalance)}**`].join('\n'));
      await interaction.editReply({ content: '', embeds: [embed] });
    } finally {
      redeemingNow.delete(code);
    }
  }

  // ---------- ปุ่ม/ฟอร์มเติมเครดิต + เช็คยอด ----------
  discordClient.on('interactionCreate', async (interaction) => {
    const cid = interaction.customId;
    if (typeof cid !== 'string' || !cid.startsWith('cs:')) return;
    try {
      // กด "เติมเครดิต" -> เลือกช่องทาง
      if (interaction.isButton() && cid === 'cs:topup') {
        await interaction.reply({ ...payMenuPayload(), ephemeral: true });
        return;
      }
      if (interaction.isButton() && cid === 'cs:pay:menu') {
        await interaction.update(payMenuPayload());
        return;
      }

      // เลือกพร้อมเพย์ -> เลือกยอด (ใช้ระบบตรวจสลิป SlipOK)
      if (interaction.isButton() && cid === 'cs:pay:promptpay') {
        if (!slipReady) {
          await interaction.reply({ content: '⛔ ระบบเติมเครดิตด้วยพร้อมเพย์ยังไม่ได้ตั้งค่า (SLIPOK_API_KEY/SLIPOK_BRANCH_ID) ติดต่อแอดมิน', ephemeral: true });
          return;
        }
        await interaction.showModal(topupAmountModal());
        return;
      }

      // เลือก TrueMoney -> เปิดฟอร์มวางลิงก์ซอง
      if (interaction.isButton() && cid === 'cs:pay:truemoney') {
        if (!truemoneyReady) {
          await interaction.reply({ content: '⛔ ระบบเติมเครดิตด้วย TrueMoney ยังไม่ได้ตั้งค่า (BOOST_TRUEMONEY_NUMBER) ติดต่อแอดมิน', ephemeral: true });
          return;
        }
        await interaction.showModal(truemoneyModal());
        return;
      }
      if (interaction.isModalSubmit() && cid === 'cs:tmmodal') {
        await handleTruemoneySubmit(interaction);
        return;
      }

      // เลือกยอดสำเร็จรูป
      if (interaction.isButton() && /^cs:amt:\d+$/.test(cid)) {
        const amount = Number(cid.slice('cs:amt:'.length));
        if (!TOPUP_PRESETS.includes(amount)) return;
        startTopup(interaction.user.id, amount);
        await interaction.deferUpdate(); // สร้าง QR อาจเกิน 3 วินาที ต้องรับ interaction ก่อน
        await interaction.editReply(await transferPayload(amount));
        return;
      }
      // ระบุยอดเอง
      if (interaction.isButton() && cid === 'cs:amt:custom') {
        await interaction.showModal(topupAmountModal());
        return;
      }
      if (interaction.isModalSubmit() && cid === 'cs:topupmodal') {
        const raw = toNumber(interaction.fields.getTextInputValue('amount').replace(/,/g, ''));
        const amount = raw === null ? null : Math.round(raw * 100) / 100;
        if (amount === null || amount <= 0) {
          await interaction.reply({ content: '⚠️ จำนวนเงินไม่ถูกต้อง', ephemeral: true });
          return;
        }
        startTopup(interaction.user.id, amount);
        await interaction.deferReply({ ephemeral: true });
        await interaction.editReply(await transferPayload(amount));
        return;
      }

      if (interaction.isButton() && cid === 'cs:balance') {
        const bal = await withWalletLock(() => wallet.balance(interaction.user.id));
        const embed = new EmbedBuilder()
          .setColor(0x57f287)
          .setDescription([`# ${EMOJI.TOPUP}  เครดิตคงเหลือของคุณ`, `## ${fmtBaht(bal)}`].join('\n'));
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      // เลือกแพ็ก -> กรอกฟอร์มสั่งซื้อ
      if (interaction.isStringSelectMenu() && cid === 'cs:tier') {
        const tier = interaction.values[0];
        if (!CUSTOMER_TIERS.includes(tier)) return;
        const modal = new ModalBuilder()
          .setCustomId(`cs:ordermodal:${tier}`)
          .setTitle(`📦 สั่งบูสต์ ${TIER_LABEL[tier]}`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('server')
                .setLabel('ลิงก์เชิญเซิร์ฟเวอร์ (วางลิงก์ที่นี่)')
                .setStyle(TextInputStyle.Paragraph) // กล่องสูง วางลิงก์สบาย
                .setPlaceholder('https://discord.gg/xxxxx')
                .setRequired(true)
                .setMaxLength(200),
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('amount')
                .setLabel('จำนวนบูสต์ (เลขคู่ ตั้งแต่ 2 ขึ้นไป)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('เช่น 2, 4, 14')
                .setRequired(true)
                .setMaxLength(6),
            ),
          );
        await interaction.showModal(modal);
        // รีเซ็ตเมนูหน้าร้านให้กลับเป็นค่าเริ่มต้น + อัปเดตสต็อก (เบื้องหลัง ไม่กระทบ modal)
        buildShopPayload()
          .then((payload) => interaction.message.edit(payload))
          .catch(() => {});
        return;
      }

      if (interaction.isModalSubmit() && cid.startsWith('cs:ordermodal:')) {
        await handleOrderSubmit(interaction, cid.slice('cs:ordermodal:'.length));
        return;
      }
    } catch (err) {
      console.error('[customer-shop] interaction error:', err);
      try {
        const msg = { content: '⚠️ เกิดข้อผิดพลาด ลองใหม่อีกครั้ง', ephemeral: true };
        if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
        else await interaction.reply(msg);
      } catch {
        /* ignore */
      }
    }
  });

  // ---------- รับรูปสลิปที่แนบมาหลังเลือกยอดพร้อมเพย์ (ตรวจเฉพาะห้องสลิปเท่านั้น) ----------
  const slipBusy = new Set();
  const isImageAttachment = (a) =>
    (a.contentType || '').startsWith('image/') || /\.(png|jpe?g|webp|heic|heif|bmp|gif)$/i.test(a.name || '');
  discordClient.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;
      if (message.channelId !== slipChannelId) return;
      const uid = message.author.id;
      const img = message.attachments.find(isImageAttachment);
      const pending = pendingTopups.get(uid);
      const expired = pending && Date.now() > pending.expiresAt;
      if (expired) pendingTopups.delete(uid);
      // ส่งรูปโดยไม่ได้เลือกยอด/หมดเวลา -> ลบทิ้งทันที กันสลิปค้างให้คนอื่นเห็น (ยกเว้นแอดมิน)
      if (img && (!pending || expired)) {
        if (!isAdmin(message.member, uid)) message.delete().catch(() => {});
        return;
      }
      if (!pending || !img) return;
      if (slipBusy.has(uid)) {
        message.delete().catch(() => {}); // ส่งซ้อนระหว่างตรวจอยู่ -> ลบทิ้ง
        return;
      }
      slipBusy.add(uid);

      // ใช้ channel.send (ไม่ reply) เพราะเราจะลบข้อความสลิปต้นทาง
      const processingMsg = await message.channel.send(`<@${uid}> ${EMOJI.LOADING}  กำลังตรวจสอบสลิป...`).catch(() => null);
      const say = (payload) => {
        const body =
          typeof payload === 'string'
            ? { content: `<@${uid}> ${payload}`, embeds: [] }
            : { ...payload, content: `<@${uid}>` };
        return processingMsg ? processingMsg.edit(body).catch(() => {}) : message.channel.send(body).catch(() => {});
      };
      // ลบข้อความผลลัพธ์ของบอทหลังผ่านไป 30 วินาที (ไม่ให้ห้องรก/ไม่โชว์ยอดเงินค้างนาน)
      const cleanupBotMsg = () => {
        if (processingMsg) setTimeout(() => processingMsg.delete().catch(() => {}), 30_000).unref();
      };
      let slipInflightId = null;
      let slipVerified = false;
      try {
        const res = await fetch(img.url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`โหลดรูปสลิปไม่สำเร็จ (HTTP ${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        message.delete().catch(() => {}); // โหลดรูปแล้ว -> ลบสลิปออกจากห้องทันที (ต้องมีสิทธิ์ Manage Messages)
        // จดลงสมุดก่อนส่งสลิปตรวจ — ถ้าบอทดับกลางทาง เปิดใหม่จะแจ้งแอดมิน/ลูกค้าให้ตรวจ
        slipInflightId = `slip:${uid}:${Date.now()}`;
        await withWalletLock(() => wallet.beginInflight(slipInflightId, { kind: 'slip', userId: uid, amount: pending.amount }));
        const data = await verifySlip({ apiKey: slipokApiKey, branchId: slipokBranchId, imageBuffer: buf, amount: pending.amount });
        const creditedAmount = toNumber(data.amount) ?? pending.amount;
        const transRef = data.transRef || null;
        if (!transRef) {
          console.error('[customer-shop] ⚠️ SlipOK ไม่ส่ง transRef กลับมา ไม่เติมเครดิต (กันสลิปซ้ำไม่ได้) user=' + uid);
          slipVerified = true; // ถึงขั้นนี้แล้วไม่ใช่ error ก่อนตรวจ
          await withWalletLock(() => wallet.endInflight(slipInflightId)).catch(() => {});
          await notifyAdmins(0xe67e22, '⚠️ สลิปผ่านแต่ไม่มีเลขอ้างอิง (ไม่เติมอัตโนมัติ)', [
            `**ลูกค้า:** <@${uid}>`,
            `**ยอดในสลิป:** ${fmtBaht(creditedAmount)}`,
            'ตรวจบัญชีรับเงินแล้วเติมด้วย `!addcredit` ถ้าเงินเข้าจริง',
          ]);
          await say('⚠️ ยืนยันเลขอ้างอิงของสลิปไม่ได้ จึงยังไม่เติมเครดิตให้ กรุณาติดต่อแอดมิน');
          return;
        }
        slipVerified = true;
        await withWalletLock(() =>
          wallet.patchInflight(slipInflightId, { status: 'verified', transRef, amount: creditedAmount }),
        ).catch((e) => console.error('[customer-shop] จดสลิปที่ตรวจแล้วลงสมุดไม่ได้:', e.message));
        let newBalance;
        try {
          newBalance = await creditWithRetry(uid, creditedAmount, { transRef, source: 'slipok', inflightId: slipInflightId });
        } catch (e) {
          if (e.code === 'DUPLICATE_REF') {
            await withWalletLock(() => wallet.endInflight(slipInflightId)).catch(() => {});
            await say(`⚠️ ${String(e.message).replace(/\s*\(transRef:[^)]*\)/, '')}`);
          } else {
            await notifyAdmins(0xed4245, '🚨 สลิปผ่านแล้วแต่เติมเครดิตไม่สำเร็จ', [
              `**ลูกค้า:** <@${uid}>`,
              `**ยอด:** ${fmtBaht(creditedAmount)}`,
              `**transRef:** \`${transRef}\``,
              `**สาเหตุ:** ${e.message}`,
              'รายการถูกจดไว้แล้ว บอทจะเติมให้อัตโนมัติเมื่อเริ่มทำงานใหม่ (หรือเติมเองด้วย `!addcredit`)',
            ]);
            await say('⚠️ ตรวจสลิปผ่านแล้ว แต่เติมเครดิตไม่สำเร็จชั่วคราว ระบบบันทึกรายการไว้แล้ว กรุณาติดต่อแอดมิน');
          }
          return;
        }
        logTopup({ userId: uid, amount: creditedAmount, balance: newBalance, source: 'slipok', transRef });
        pendingTopups.delete(uid); // เติมสำเร็จแล้ว ใช้ได้ครั้งเดียวต่อการเลือกยอด
        const done = new EmbedBuilder()
          .setColor(0x57f287)
          .setDescription([`# ${EMOJI.SUCCESS}  เติมเครดิตเสร็จสิ้น`, `## +${fmtBaht(creditedAmount)}`, `เครดิตคงเหลือ: **${fmtBaht(newBalance)}**`].join('\n'));
        await say({ content: '', embeds: [done] });
      } catch (err) {
        message.delete().catch(() => {}); // ตรวจไม่ผ่านก็ไม่ปล่อยสลิปค้างในห้อง
        if (slipInflightId && !slipVerified) await withWalletLock(() => wallet.endInflight(slipInflightId)).catch(() => {});
        console.error('[customer-shop] ตรวจสลิปไม่ผ่าน:', err && err.message);
        await say(`⚠️ ตรวจสลิปไม่สำเร็จ: ${(err && err.userMessage) || (err && err.message) || 'ลองใหม่อีกครั้ง'}\n-# ส่งสลิปใหม่ได้ในห้องนี้ภายในเวลาที่เหลือ หรือกดเลือกยอดใหม่`);
      } finally {
        slipBusy.delete(uid);
        cleanupBotMsg();
      }
    } catch (err) {
      console.error('[customer-shop] slip handling error:', err);
    }
  });

  // ---------- กดส่งฟอร์มสั่งบูสต์ ----------
  async function handleOrderSubmit(interaction, tier) {
    await interaction.deferReply({ ephemeral: true }); // ข้อความถึงลูกค้าเห็นเฉพาะคนสั่ง
    const userId = interaction.user.id;
    try {
      const input = validateOrderInput(
        interaction.fields.getTextInputValue('server'),
        tier,
        interaction.fields.getTextInputValue('amount'),
      );
      const unitPrice = CUSTOMER_PRICE[input.tier];
      const totalPrice = unitPrice * input.amount;

      // เตรียมออเดอร์ก่อน (อ่านอย่างเดียว ยังไม่แตะเครดิตใคร) — กันสั่งซ้ำพารามิเตอร์เดิมด้วย
      const draft = await melodyService.prepare(input.server, input.tier, input.amount, input.nick);
      // สร้างเลขอ้างอิงออเดอร์ล่วงหน้า แล้วผูกกับการหักเครดิต — ถ้าบอทดับ จะตามออเดอร์เจอและคืนเครดิตได้
      const clientRef = `order-${crypto.randomUUID().replace(/-/g, '')}`;
      draft.client_reference = clientRef;

      const currentBalance = await withWalletLock(() => wallet.balance(userId));
      if (currentBalance < totalPrice) {
        await interaction.editReply(
          `⛔ เครดิตไม่พอ ต้องใช้ **${fmtBaht(totalPrice)}** (${input.amount} × ${fmtBaht(unitPrice)}) แต่คุณมี **${fmtBaht(currentBalance)}** — กด "เติมเครดิต" ที่หน้าร้านก่อนนะ`,
        );
        return;
      }

      // หักเครดิตลูกค้าแบบ atomic ก่อนยิงบูสต์จริง (กันกดซ้ำ/race)
      const debitRes = await withWalletLock(() =>
        wallet.debitForOrder(userId, totalPrice, clientRef, {
          tier: input.tier,
          qty: input.amount,
          server: input.server,
        }),
      );
      if (!debitRes.ok) {
        await interaction.editReply('⛔ เครดิตไม่พอ (ยอดเปลี่ยนไประหว่างตรวจสอบ) ลองใหม่อีกครั้ง');
        return;
      }

      // โพสต์หน้าสรุปสถานะ "กำลังบูสต์" ขึ้นห้องสถานะทันที
      const guildInfo = await resolveInviteGuild(input.server);
      const view = {
        username: interaction.user.username,
        tier: input.tier,
        requested: input.amount,
        guildName: guildInfo.name,
        guildIcon: guildInfo.icon,
      };
      const statusMsg = await postStatus({ content: '', embeds: [buildStatusEmbed({ ...view, state: 'processing' })] });
      if (statusMsg) {
        // จำที่อยู่หน้าสถานะไว้ เผื่อบอทดับแล้วต้องอัปเดตผลให้ตอนกู้ออเดอร์
        await withWalletLock(() =>
          wallet.patchOrder(clientRef, { view, statusChannelId: statusMsg.channelId, statusMessageId: statusMsg.id }),
        ).catch(() => {});
      }

      if (statusMsg) {
        const ack = new EmbedBuilder()
          .setColor(0xfee75c)
          .setDescription(
            [
              `# ${EMOJI.LOADING} รับออเดอร์แล้ว กำลังบูสต์`,
              `ดูหน้าสถานะได้ที่ ${statusMsg.url}`,
              '',
              `**ยอดที่หัก:** ${fmtBaht(totalPrice)}`,
              `**เครดิตคงเหลือ:** ${fmtBaht(debitRes.balance)}`,
              '*โปรดรอสักครู่ อย่ากดสั่งซ้ำ*',
            ].join('\n'),
          );
        await interaction.editReply({ content: '', embeds: [ack] }).catch(() => {});
      } else {
        // ส่งเข้าห้องสถานะไม่ได้ (เช่นบอทไม่มีสิทธิ์) -> แสดงหน้าสถานะในข้อความของลูกค้าเองแทน
        await interaction
          .editReply({ content: '', embeds: [buildStatusEmbed({ ...view, state: 'processing' })] })
          .catch(() => {});
      }
      runCustomerOrder({ userId, draft, ref: clientRef, totalPrice, amount: input.amount, view, statusMsg, interaction }).catch(async (err) => {
        // หักเครดิตแล้วแต่ขั้นตอนหลังบ้านพัง -> ห้ามเงียบ แจ้งแอดมินให้ตรวจ/คืนเครดิตมือ
        console.error('[customer-shop] ⚠️ runCustomerOrder พังหลังหักเครดิต:', err);
        await notifyAdmins(0xed4245, '🚨 ออเดอร์ลูกค้าพังหลังหักเครดิต (ต้องตรวจมือ)', [
          `**อ้างอิง:** \`${clientRef}\` (ออเดอร์ยังค้างในสมุด จะถูกตรวจ/คืนเครดิตอัตโนมัติตอนบอทเริ่มใหม่)`,
          `**ผู้สั่ง:** <@${userId}>`,
          `**ยอดที่หัก:** ${fmtBaht(totalPrice)}`,
          `**สาเหตุ:** ${(err && err.message) || 'ไม่ทราบ'}`,
        ]);
        interaction
          .followUp({ content: `⚠️ เกิดข้อผิดพลาดระหว่างดำเนินการ ยอดที่หัก ${fmtBaht(totalPrice)} ถูกบันทึกไว้แล้ว กรุณาติดต่อแอดมิน`, ephemeral: true })
          .catch(() => {});
      });
    } catch (err) {
      await interaction.editReply(`⚠️ ${safeErr(err)}`).catch(() => {});
    }
  }

  // ---------- คำนวณยอดคืนจากผลลัพธ์สุดท้ายของ Melody ----------
  function computeRefund(snap, totalPrice, amount) {
    const requested = snap.boosts_requested ?? amount;
    const applied = snap.boosts_applied ?? 0;
    const complete = snap.status === 'completed' || (requested > 0 && applied >= requested);

    let refundAmount = 0;
    let refundNote;
    if (complete) {
      refundNote = 'บูสต์ส่งครบตามจำนวนที่สั่ง ไม่มีการคืนเครดิต';
    } else if (snap.failure_reason && NO_REFUND_FAILURE_REASONS.has(snap.failure_reason)) {
      refundNote = 'ไม่สามารถบูสต์เซิร์ฟเวอร์นี้ได้ครบ (ตรวจสอบว่าลิงก์เชิญยังไม่หมดอายุและใช้ได้ไม่จำกัด) ตามเงื่อนไขของร้านจะไม่คืนเครดิตของออเดอร์นี้ หากมีข้อสงสัยติดต่อแอดมิน';
    } else if (snap.price_charged && snap.refunded !== null && snap.refunded > 0) {
      const ratio = Math.min(1, snap.refunded / snap.price_charged);
      refundAmount = Math.round(totalPrice * ratio * 100) / 100;
      refundNote = 'คืนเครดิตตามสัดส่วนบูสต์ที่ไม่สำเร็จ';
    } else if (requested > 0 && applied < requested) {
      const ratio = (requested - applied) / requested;
      refundAmount = Math.round(totalPrice * ratio * 100) / 100;
      refundNote = `บูสต์ไม่ครบจำนวน คืนเครดิตตามสัดส่วนที่ขาด (${applied}/${requested})`;
    } else {
      refundNote = 'ไม่มีส่วนที่ต้องคืน';
    }
    return { requested, applied, complete, refundAmount, refundNote };
  }

  // ---------- สรุปออเดอร์ที่ทราบผลสุดท้ายแล้ว: คืนเครดิต + ปิดออเดอร์ (atomic) + แจ้งลูกค้า/แอดมิน ----------
  // ใช้ร่วมกันทั้งตอนออเดอร์จบปกติ และตอนกู้ออเดอร์หลังบอทดับ — เรียกซ้ำปลอดภัย (ปิดไปแล้วจะไม่คืนซ้ำ)
  async function finalizeOrder({ userId, ref, snap, totalPrice, amount, updateStatus, tellUser, recovered = false }) {
    const { requested, applied, complete, refundAmount, refundNote } = computeRefund(snap, totalPrice, amount);
    const res = await withWalletLock(() => wallet.settleOrder(ref, refundAmount, { reason: 'order_shortfall' }));
    if (!res.settled) {
      console.log(`[customer-shop] ออเดอร์ ${ref} ถูกสรุปไปแล้ว ข้าม`);
      return;
    }
    const refunded = res.refunded;
    const newBal = refunded > 0 ? res.balance : null;

    const state = complete ? 'completed' : applied > 0 ? 'partial' : 'failed';
    await updateStatus(state, { applied, requested, before: snap.boosts_before ?? null, after: snap.boosts_after ?? null });
    refreshShops('มีออเดอร์บูสต์เสร็จ').catch(() => {}); // หน้าร้านอัปเดตสต็อก/ยอดบูสต์ทันที

    // ข้อความถึงลูกค้า (เห็นเฉพาะคนสั่ง) — ไม่มีข้อมูลเทคนิค
    const statusLabel = { completed: 'สำเร็จ', partial: 'สำเร็จบางส่วน', failed: 'ไม่สำเร็จ' }[state];
    const color = { completed: 0x57f287, partial: 0xe67e22, failed: 0xed4245 }[state];
    const customerEmbed = new EmbedBuilder()
      .setColor(color)
      .setDescription(
        [
          `# ${{ completed: '✅', partial: '⚠️', failed: '❌' }[state]} บูสต์เสร็จสิ้น`,
          `## ผล: **${statusLabel}**`,
          `บูสต์สำเร็จ: **${applied}/${requested}**`,
          refundNote,
          refunded > 0 ? `คืนเครดิต: **${fmtBaht(refunded)}** (คงเหลือ: **${fmtBaht(newBal)}**)` : '',
        ].filter(Boolean).join('\n'),
      );
    await tellUser({
      content: recovered ? 'ℹ️ บอทเพิ่งกลับมาออนไลน์หลังสะดุด และสรุปออเดอร์ของคุณให้แล้ว' : '',
      embeds: [customerEmbed],
    });

    // log สำหรับแอดมิน (มี client_reference)
    await notifyAdmins(
      color,
      `${{ completed: '✅', partial: '⚠️', failed: '❌' }[state]} สรุปออเดอร์ลูกค้า${recovered ? ' (กู้หลังบอทเริ่มใหม่)' : ''}`,
      [`**ผู้สั่ง:** <@${userId}>`, `**สถานะ:** ${statusLabel} (${snap.status})`],
      [
        { name: 'บูสต์', value: `${applied}/${requested}`, inline: true },
        { name: 'ยอดที่หัก', value: fmtBaht(totalPrice), inline: true },
        { name: 'คืนเครดิต', value: refunded > 0 ? fmtBaht(refunded) : 'ไม่มี', inline: true },
        { name: 'client_reference', value: `\`${ref}\`` },
      ],
    );
  }

  // ---------- ยิงออเดอร์จริง + คืนเครดิตตามผลลัพธ์ + อัปเดตหน้าสถานะ ----------
  async function runCustomerOrder({ userId, draft, ref, totalPrice, amount, view, statusMsg, interaction }) {
    const updateStatus = async (state, extra = {}) => {
      const payload = { content: '', embeds: [buildStatusEmbed({ ...view, state, ...extra })] };
      try {
        if (statusMsg) await statusMsg.edit(payload);
        else await interaction.editReply(payload);
      } catch (e) {
        console.error('[customer-shop] แก้หน้าสถานะไม่ได้:', e && e.message);
      }
    };
    const tellUser = (payload) =>
      interaction.followUp({ ...payload, ephemeral: true }).catch((e) => console.error('[customer-shop] ส่งข้อความหาลูกค้าไม่ได้:', e && e.message));
    const tell = (text) => tellUser({ content: text });
    const orderLines = () => [`**ผู้สั่ง:** <@${userId}>`, `**ยอดที่หัก:** ${fmtBaht(totalPrice)}`];
    const markReview = () => withWalletLock(() => wallet.patchOrder(ref, { status: 'review' })).catch(() => {});

    let record;
    try {
      record = await melodyService.submit(draft);
    } catch (err) {
      console.error('[customer-shop] submit error:', err && err.message);
      // ไม่มีออเดอร์ในไฟล์ประวัติ = ยังไม่เคยยิง POST แน่นอน -> ปลอดภัยที่จะคืนเครดิตเต็ม
      let notSent = false;
      try {
        notSent = !melodyService.get(ref);
      } catch {
        notSent = false;
      }
      if (notSent) {
        const res = await withWalletLock(() => wallet.settleOrder(ref, totalPrice, { reason: 'not_submitted' }));
        await updateStatus('failed', { applied: 0 });
        await tell(`❌ ส่งออเดอร์ไม่สำเร็จ ระบบคืนเครดิตเต็มจำนวน **${fmtBaht(totalPrice)}** แล้ว (คงเหลือ: **${fmtBaht(res.balance)}**) ลองสั่งใหม่อีกครั้งได้เลย`);
        await notifyAdmins(0xe67e22, '⚠️ ออเดอร์ลูกค้า: ส่งไม่ได้ (คืนเครดิตเต็มแล้ว)', [...orderLines(), `**สาเหตุ:** ${(err && err.message) || 'ไม่ทราบ'}`]);
        return;
      }
      await markReview();
      await updateStatus('review');
      await tell(`⚠️ เกิดข้อผิดพลาดระหว่างสั่งออเดอร์ ออเดอร์ของคุณถูกบันทึกไว้แล้ว ยอดที่หัก ${fmtBaht(totalPrice)} ยังไม่ถูกคืนจนกว่าแอดมินจะตรวจสอบ กรุณาติดต่อแอดมิน`);
      await notifyAdmins(0xe67e22, '⚠️ ออเดอร์ลูกค้า: ส่งคำสั่งไม่สำเร็จ', [...orderLines(), `**สาเหตุ:** ${(err && err.message) || 'ไม่ทราบ'}`]);
      return;
    }
    const refField = { name: 'client_reference', value: `\`${record.client_reference}\`` };

    if (record.state === 'rejected') {
      // ระบบปฏิเสธคำขอ ไม่เกิดออเดอร์จริง -> คืนเครดิตลูกค้าเต็มจำนวน (และปิดออเดอร์ในสมุด)
      const res = await withWalletLock(() => wallet.settleOrder(ref, totalPrice, { reason: 'rejected' }));
      await updateStatus('failed', { applied: 0 });
      await tell(`❌ ออเดอร์ไม่สำเร็จ ระบบคืนเครดิตเต็มจำนวน **${fmtBaht(totalPrice)}** แล้ว (คงเหลือ: **${fmtBaht(res.balance)}**)\nตรวจสอบว่าลิงก์เชิญยังไม่หมดอายุและใช้ได้ไม่จำกัด แล้วลองใหม่อีกครั้ง`);
      await notifyAdmins(0xed4245, '❌ ออเดอร์ลูกค้าถูกปฏิเสธ (คืนเครดิตเต็มแล้ว)', [...orderLines(), `**หมายเหตุ:** ${record.note || '-'}`], [refField]);
      return;
    }

    const reviewNotice = async (title, why) => {
      await markReview();
      await updateStatus('review');
      await tell(`🕒 ออเดอร์ของคุณอยู่ระหว่างตรวจสอบ ยอดที่หัก ${fmtBaht(totalPrice)} จะยังไม่ถูกคืนจนกว่าจะทราบผล กรุณาติดต่อแอดมิน`);
      await notifyAdmins(0xfee75c, title, [...orderLines(), `**รายละเอียด:** ${why}`, 'ติดตามด้วย `!boosttrack <client_reference>`'], [refField]);
    };

    if (!['posting', 'tracking', 'unconfirmed'].includes(record.state) && record.state !== 'final') {
      await reviewNotice('🕒 ออเดอร์ลูกค้า: ยังไม่ทราบผล', record.note || record.state);
      return;
    }

    let lastKey = null;
    let final;
    try {
      final = await melodyService.track(record.client_reference, async (rec, snap) => {
        if (!snap) return;
        if (['completed', 'partial', 'failed', 'api_failed'].includes(snap.status)) return; // ผลสุดท้ายแสดงตอนจบ
        const key = `${snap.status}|${snap.boosts_applied}`;
        if (key === lastKey) return;
        lastKey = key;
        await updateStatus('processing', { applied: snap.boosts_applied ?? 0 });
      });
    } catch (err) {
      await reviewNotice('⚠️ ออเดอร์ลูกค้า: ติดตามผลไม่สำเร็จ', (err && err.message) || 'ไม่ทราบ');
      return;
    }

    if (final.state === 'pending_review') {
      await reviewNotice('🕒 ออเดอร์ลูกค้า: รอตรวจสอบ (ติดตามเกินเวลา)', final.note || 'pending_review');
      return;
    }
    const snap = final.last_snapshot;
    if (!snap) {
      await reviewNotice('⚠️ ออเดอร์ลูกค้า: ไม่พบผลลัพธ์', 'ไม่มี snapshot');
      return;
    }
    await finalizeOrder({ userId, ref, snap, totalPrice, amount, updateStatus, tellUser });
  }

  // ====================== กู้รายการค้างหลังบอทดับ/รีสตาร์ท ======================
  async function dmUser(userId, payload) {
    try {
      const u = await discordClient.users.fetch(userId);
      await u.send(payload);
    } catch (e) {
      console.error(`[customer-shop] ส่ง DM หาลูกค้า ${userId} ไม่ได้:`, e && e.message);
    }
  }

  const makeStatusUpdater = (order) => async (state, extra = {}) => {
    if (!order.statusChannelId || !order.statusMessageId || !order.view) return;
    try {
      const ch = await discordClient.channels.fetch(order.statusChannelId);
      const msg = await ch.messages.fetch(order.statusMessageId);
      await msg.edit({ content: '', embeds: [buildStatusEmbed({ ...order.view, state, ...extra })] });
    } catch (e) {
      console.error('[customer-shop] กู้หน้าสถานะไม่ได้:', e && e.message);
    }
  };

  // การเติมเครดิตที่ค้าง (รับซอง/ตรวจสลิป) จากรอบก่อนที่บอทดับ
  async function recoverInflight(f) {
    const known = (f.status === 'redeemed' || f.status === 'verified') && typeof f.amount === 'number' && f.amount > 0;
    const transRef = f.kind === 'truemoney' ? (f.code ? `truemoney:${f.code}` : null) : f.transRef || null;
    if (known && transRef) {
      try {
        const newBal = await creditWithRetry(f.userId, f.amount, {
          transRef,
          source: f.kind === 'truemoney' ? 'truemoney' : 'slipok',
          from: f.ownerName,
          inflightId: f.id,
          recovered: true,
        });
        logTopup({ userId: f.userId, amount: f.amount, balance: newBal, source: f.kind === 'truemoney' ? 'truemoney' : 'slipok', from: f.ownerName, transRef, recovered: true });
        await dmUser(f.userId, { content: `✅ บอทเพิ่งกลับมาออนไลน์ และเติมเครดิตที่ค้างอยู่ให้แล้ว **+${fmtBaht(f.amount)}** (คงเหลือ: **${fmtBaht(newBal)}**)` });
        await notifyAdmins(0x57f287, '✅ กู้การเติมเครดิตที่ค้างสำเร็จ', [`**ลูกค้า:** <@${f.userId}>`, `**ช่องทาง:** ${f.kind}`, `**ยอด:** ${fmtBaht(f.amount)}`]);
      } catch (e) {
        if (e && e.code === 'DUPLICATE_REF') {
          await withWalletLock(() => wallet.endInflight(f.id)).catch(() => {}); // เติมไปแล้ว แค่ปิดรายการ
          return;
        }
        throw e; // เติมไม่ได้ -> คงรายการไว้ ลองใหม่รอบหน้า
      }
      return;
    }
    // ไม่ทราบผล (บอทดับก่อนรู้ว่าเงินเข้าหรือยัง) -> ให้คนตรวจ
    await notifyAdmins(0xe67e22, '⚠️ มีการเติมเครดิตค้างตอนบอทดับ (ต้องตรวจมือ)', [
      `**ลูกค้า:** <@${f.userId}>`,
      `**ช่องทาง:** ${f.kind === 'truemoney' ? 'ซอง TrueMoney' : 'พร้อมเพย์ (สลิป)'}`,
      f.code ? `**โค้ดซอง:** \`${f.code}\`` : `**ยอดที่เลือก:** ${fmtBaht(f.amount || 0)}`,
      `**เริ่มเมื่อ:** ${f.startedAt}`,
      'ตรวจบัญชีรับเงิน/TrueMoney ร้านว่าเงินเข้าไหม ถ้าเข้าแล้วให้เติมด้วย `!addcredit`',
    ]);
    await dmUser(f.userId, { content: 'ℹ️ ระบบสะดุดระหว่างที่คุณเติมเครดิต ถ้าเงินถูกหักแล้วแต่เครดิตไม่เข้า กรุณาติดต่อแอดมินพร้อมหลักฐาน (สลิป/ลิงก์ซอง)' });
    await withWalletLock(() => wallet.endInflight(f.id)).catch(() => {});
  }

  // ออเดอร์ที่หักเครดิตแล้วแต่ยังไม่สรุป
  async function recoverOrder(o) {
    const ref = o.ref;
    const userId = o.userId;
    const totalPrice = o.charged;
    const amount = o.qty;
    const updateStatus = makeStatusUpdater(o);
    const tellUser = (payload) => dmUser(userId, payload);
    const lines = [`**ผู้สั่ง:** <@${userId}>`, `**ยอดที่หัก:** ${fmtBaht(totalPrice)}`, `**อ้างอิง:** \`${ref}\``];

    const settleFull = async (why, note) => {
      const res = await withWalletLock(() => wallet.settleOrder(ref, totalPrice, { reason: why }));
      if (!res.settled) return;
      await updateStatus('failed', { applied: 0 });
      await tellUser({ content: `ℹ️ บอทเพิ่งกลับมาออนไลน์หลังสะดุด ออเดอร์ของคุณไม่ได้ถูกดำเนินการ ระบบคืนเครดิตเต็มจำนวน **${fmtBaht(totalPrice)}** แล้ว (คงเหลือ: **${fmtBaht(res.balance)}**) สั่งใหม่ได้เลย` });
      await notifyAdmins(0xe67e22, '♻️ กู้ออเดอร์หลังบอทเริ่มใหม่: คืนเครดิตเต็ม', [...lines, `**เหตุผล:** ${note}`]);
    };
    const needsReview = async (why) => {
      await withWalletLock(() => wallet.patchOrder(ref, { status: 'review' })).catch(() => {});
      await updateStatus('review');
      await dmUser(userId, { content: `🕒 ออเดอร์ของคุณยังไม่ทราบผลหลังบอทสะดุด ยอดที่หัก ${fmtBaht(totalPrice)} จะยังไม่ถูกคืนจนกว่าจะทราบผล กรุณาติดต่อแอดมิน` });
      await notifyAdmins(0xfee75c, '🕒 กู้ออเดอร์หลังบอทเริ่มใหม่: ยังไม่ทราบผล (ต้องตรวจมือ)', [...lines, `**รายละเอียด:** ${why}`, 'ติดตามด้วย `!boosttrack <client_reference>`']);
    };

    let rec = null;
    try {
      rec = melodyService.get(ref);
    } catch (e) {
      await needsReview(`อ่านไฟล์ประวัติออเดอร์ไม่ได้: ${e.message}`);
      return;
    }
    // ไม่มีออเดอร์ในไฟล์ประวัติ = บอทดับก่อนยิง POST -> ไม่เกิดออเดอร์จริง คืนเต็ม
    if (!rec) return settleFull('recovered_not_submitted', 'บอทดับก่อนส่งออเดอร์ (ไม่มีออเดอร์จริง)');
    if (rec.state === 'rejected') return settleFull('recovered_rejected', rec.note || 'ระบบปฏิเสธออเดอร์');

    if (rec.state === 'final' && rec.last_snapshot) {
      return finalizeOrder({ userId, ref, snap: rec.last_snapshot, totalPrice, amount, updateStatus, tellUser, recovered: true });
    }

    if (['posting', 'unconfirmed', 'tracking', 'pending_review'].includes(rec.state)) {
      if (melodyService.isTracking(ref)) return;
      let final;
      try {
        final = await melodyService.track(ref);
      } catch (e) {
        await needsReview(`ติดตามผลไม่สำเร็จ: ${(e && e.message) || 'ไม่ทราบ'}`);
        return;
      }
      if (final.state === 'rejected') return settleFull('recovered_rejected', final.note || 'ระบบปฏิเสธออเดอร์');
      if (final.state === 'final' && final.last_snapshot) {
        return finalizeOrder({ userId, ref, snap: final.last_snapshot, totalPrice, amount, updateStatus, tellUser, recovered: true });
      }
      await needsReview(final.note || `สถานะ ${final.state}`);
      return;
    }
    await needsReview(`สถานะออเดอร์ไม่คาดคิด: ${rec.state}`);
  }

  async function recoverOnStartup() {
    let inflight = [];
    let orders = [];
    try {
      inflight = (await withWalletLock(() => wallet.listInflight())).filter((x) => x.startedAt < bootTime);
      orders = (await withWalletLock(() => wallet.listOrders())).filter((x) => x.createdAt < bootTime);
    } catch (e) {
      console.error('[customer-shop] 🚨 อ่านรายการค้างไม่ได้:', e.message);
      return;
    }
    if (!inflight.length && !orders.length) return;
    console.log(`[customer-shop] พบรายการค้างจากรอบก่อน: เติมเครดิต ${inflight.length}, ออเดอร์ ${orders.length} — กำลังกู้`);
    for (const f of inflight) {
      await recoverInflight(f).catch((e) => console.error(`[customer-shop] กู้รายการเติมเครดิต ${f.id} ไม่สำเร็จ:`, e && e.message));
    }
    await Promise.all(
      orders.map((o) => recoverOrder(o).catch((e) => console.error(`[customer-shop] กู้ออเดอร์ ${o.ref} ไม่สำเร็จ:`, e && e.message))),
    );
  }

  let recoveryStarted = false;
  const startRecovery = () => {
    if (recoveryStarted) return;
    recoveryStarted = true;
    recoverOnStartup().catch((e) => console.error('[customer-shop] กู้รายการค้างพลาด:', e));
  };
  if (typeof discordClient.isReady === 'function' && discordClient.isReady()) startRecovery();
  else {
    discordClient.once('ready', startRecovery);
    discordClient.once('clientReady', startRecovery);
  }

  console.log(`[customer-shop] พร้อมใช้งาน (ไฟล์กระเป๋าเครดิต: ${walletFile}, ราคา 1m=${price1m}บาท/ลูก 3m=${price3m}บาท/ลูก)`);
  return { wallet, CUSTOMER_PRICE, postShop, drain: () => walletChain };
}

module.exports = { setupCustomerShop, validateOrderInput };
