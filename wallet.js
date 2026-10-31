'use strict';
/**
 * wallet.js — กระเป๋าเครดิตลูกค้า เก็บลง JSON file
 * รองรับ credit / debit / refund / balance
 * ไม่มี locking ภายในตัว — ต้อง wrap ด้วย mutex/chain จากฝั่งที่เรียก (เช่น withWalletLock ใน customerShop.js)
 *
 * กันเครดิตหายตอนบอทดับ:
 *  1) เขียนไฟล์แบบ atomic (tmp -> fsync -> rename) + สำรองเวอร์ชันก่อนหน้าไว้ที่ <file>.bak ทุกครั้ง
 *     และเก็บสแนปช็อตรายวันไว้ที่ wallet_backups/ (เก็บ 14 วัน)
 *  2) ถ้าไฟล์หลักเสีย/หาย จะกู้จาก .bak อัตโนมัติ (เก็บไฟล์เสียไว้เป็น .corrupt-<เวลา> ไม่ลบทิ้ง)
 *  3) สมุดบันทึกล่วงหน้า (write-ahead journal) อยู่ในไฟล์เดียวกัน เขียนพร้อมกับยอดเงินแบบ atomic
 *     - orders:   ออเดอร์ที่หักเครดิตแล้วแต่ยังไม่สรุปผล (ถ้าบอทดับ เปิดใหม่จะกู้/คืนเครดิตให้)
 *     - inflight: การเติมเครดิตที่กำลังทำ (รับซอง / ตรวจสลิป) ที่ยังไม่เสร็จ
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKUP_KEEP_DAYS = 14;

class WalletStore {
  /**
   * @param {string} file — path ไฟล์ JSON ที่จะเก็บข้อมูล
   */
  constructor(file) {
    this.file = path.resolve(file);
    this.bakFile = `${this.file}.bak`;
    this.snapDir = path.join(path.dirname(this.file), 'wallet_backups');
  }

  // ---------- internal ----------
  _emptyData() {
    return { version: 2, wallets: {}, txLog: [], usedRefs: {}, orders: {}, inflight: {} };
  }

  _parseFile(file) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`อ่านไฟล์กระเป๋าเครดิตไม่ได้: ${file} (${err.code || err.message})`);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`ไฟล์กระเป๋าเครดิต JSON ไม่ถูกต้อง: ${file}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`รูปแบบไฟล์กระเป๋าเครดิตไม่ถูกต้อง: ${file}`);
    }
    return data;
  }

  _normalize(data) {
    if (!data.wallets || typeof data.wallets !== 'object') data.wallets = {};
    if (!Array.isArray(data.txLog)) data.txLog = [];
    // usedRefs = ทะเบียนสลิป/ซองที่เคยเติมแล้ว เก็บถาวร (ไม่ถูกตัดทิ้งเหมือน txLog) กันใช้ซ้ำหลัง log เกิน 5000 รายการ
    if (!data.usedRefs || typeof data.usedRefs !== 'object') data.usedRefs = {};
    if (!data.orders || typeof data.orders !== 'object') data.orders = {};
    if (!data.inflight || typeof data.inflight !== 'object') data.inflight = {};
    for (const tx of data.txLog) {
      if (tx && tx.type === 'credit' && tx.transRef && !data.usedRefs[tx.transRef]) data.usedRefs[tx.transRef] = tx.timestamp || true;
    }
    return data;
  }

  _read() {
    const mainExists = fs.existsSync(this.file);
    if (mainExists) {
      try {
        return this._normalize(this._parseFile(this.file));
      } catch (mainErr) {
        // ไฟล์หลักเสีย -> ลองกู้จาก .bak
        if (!fs.existsSync(this.bakFile)) throw mainErr;
        let bak;
        try {
          bak = this._normalize(this._parseFile(this.bakFile));
        } catch {
          throw mainErr; // .bak ก็ใช้ไม่ได้ -> ไม่แตะอะไร ให้คนตรวจมือ
        }
        const corruptCopy = `${this.file}.corrupt-${Date.now()}`;
        try { fs.renameSync(this.file, corruptCopy); } catch { /* ignore */ }
        console.error(`[wallet] ⚠️ ไฟล์หลักเสีย (${mainErr.message}) — กู้จาก ${this.bakFile} แล้ว (เก็บไฟล์เสียไว้ที่ ${corruptCopy}) รายการหลังการบันทึกล่าสุดอาจหาย ให้ตรวจ log`);
        this._write(bak, { skipBackup: true });
        return bak;
      }
    }
    // ไฟล์หลักหาย แต่มี .bak -> กู้
    if (fs.existsSync(this.bakFile)) {
      try {
        const bak = this._normalize(this._parseFile(this.bakFile));
        console.error(`[wallet] ⚠️ ไม่พบไฟล์หลัก ${this.file} — กู้จาก .bak แล้ว`);
        this._write(bak, { skipBackup: true });
        return bak;
      } catch { /* ตกไปสร้างใหม่ */ }
    }
    return this._emptyData();
  }

  _snapshotDaily() {
    try {
      if (!fs.existsSync(this.file)) return;
      fs.mkdirSync(this.snapDir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      const snap = path.join(this.snapDir, `wallet-${day}.json`);
      if (!fs.existsSync(snap)) {
        fs.copyFileSync(this.file, snap);
        const old = fs
          .readdirSync(this.snapDir)
          .filter((f) => /^wallet-\d{4}-\d{2}-\d{2}\.json$/.test(f))
          .sort()
          .slice(0, -BACKUP_KEEP_DAYS);
        for (const f of old) fs.unlinkSync(path.join(this.snapDir, f));
      }
    } catch (err) {
      console.error('[wallet] สำรองรายวันไม่สำเร็จ:', err.message);
    }
  }

  _write(data, { skipBackup = false } = {}) {
    const dir = path.dirname(this.file);
    const tmp = path.join(dir, `.wallet-${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(data, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (!skipBackup && fs.existsSync(this.file)) {
        try {
          this._snapshotDaily();
          fs.copyFileSync(this.file, this.bakFile); // เก็บเวอร์ชันก่อนหน้าไว้กู้
        } catch (err) {
          console.error('[wallet] สำรอง .bak ไม่สำเร็จ (ยังบันทึกต่อ):', err.message);
        }
      }
      fs.renameSync(tmp, this.file);
      // fsync โฟลเดอร์ให้การ rename ทนไฟดับ (ใช้ไม่ได้บางระบบ เช่น Windows — ข้ามได้)
      try {
        const dfd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
      } catch { /* ignore */ }
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw new Error(`บันทึกไฟล์กระเป๋าเครดิตไม่ได้ (${err.code || err.message})`);
    }
  }

  _ensureWallet(data, userId) {
    if (!data.wallets[userId]) {
      data.wallets[userId] = { balance: 0 };
    }
    return data.wallets[userId];
  }

  _logTx(data, userId, type, amount, meta = {}) {
    data.txLog.push({
      id: crypto.randomUUID(),
      userId,
      type,
      amount,
      timestamp: new Date().toISOString(),
      ...meta,
    });
    // เก็บ log ไม่เกิน 5000 รายการ (กัน file บวม)
    if (data.txLog.length > 5000) {
      data.txLog = data.txLog.slice(-4000);
    }
  }

  static _checkAmount(amount, label) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error(`จำนวนเงิน${label}ต้องเป็นตัวเลขมากกว่า 0`);
    }
  }

  // ---------- public API ----------

  /** ตรวจว่าไฟล์อ่านได้ (และกู้จาก .bak ถ้าจำเป็น) — เรียกตอนบอทเริ่ม */
  selfCheck() {
    this._read();
  }

  /**
   * ดูยอดเครดิตคงเหลือ
   * @param {string} userId
   * @returns {number}
   */
  balance(userId) {
    const data = this._read();
    const w = data.wallets[userId];
    return w ? w.balance : 0;
  }

  /** transRef นี้เคยเติมไปแล้วหรือยัง */
  isRefUsed(transRef) {
    return Boolean(this._read().usedRefs[transRef]);
  }

  /**
   * เติมเครดิต (เงินเข้า)
   * @param {string} userId
   * @param {number} amount — จำนวนเงินที่เติม (> 0)
   * @param {object} meta — ข้อมูลเพิ่มเติม เช่น { transRef, source }
   *        meta.inflightId — ถ้าใส่ จะลบรายการ inflight นั้นออก "ในการเขียนครั้งเดียวกัน" (atomic)
   * @returns {number} — ยอดคงเหลือหลังเติม
   */
  credit(userId, amount, meta = {}) {
    WalletStore._checkAmount(amount, 'เติม');
    const { inflightId, ...logMeta } = meta;
    // กันสลิปซ้ำด้วย transRef
    const data = this._read();
    if (logMeta.transRef) {
      if (data.usedRefs[logMeta.transRef]) {
        const e = new Error(`สลิป/ซองนี้ถูกใช้ไปแล้ว (transRef: ${logMeta.transRef})`);
        e.code = 'DUPLICATE_REF';
        throw e;
      }
      data.usedRefs[logMeta.transRef] = new Date().toISOString();
    }
    const w = this._ensureWallet(data, userId);
    w.balance = Math.round((w.balance + amount) * 100) / 100;
    this._logTx(data, userId, 'credit', amount, logMeta);
    if (inflightId) delete data.inflight[inflightId];
    this._write(data);
    return w.balance;
  }

  /**
   * หักเครดิต (เงินออก)
   * @returns {{ ok: boolean, balance: number }}
   */
  debit(userId, amount, meta = {}) {
    WalletStore._checkAmount(amount, 'หัก');
    const data = this._read();
    const w = this._ensureWallet(data, userId);
    if (w.balance < amount) {
      return { ok: false, balance: w.balance };
    }
    w.balance = Math.round((w.balance - amount) * 100) / 100;
    this._logTx(data, userId, 'debit', amount, meta);
    this._write(data);
    return { ok: true, balance: w.balance };
  }

  /**
   * คืนเครดิต (refund)
   * @returns {number} — ยอดคงเหลือหลังคืน
   */
  refund(userId, amount, meta = {}) {
    WalletStore._checkAmount(amount, 'คืน');
    const data = this._read();
    const w = this._ensureWallet(data, userId);
    w.balance = Math.round((w.balance + amount) * 100) / 100;
    this._logTx(data, userId, 'refund', amount, meta);
    this._write(data);
    return w.balance;
  }

  // ---------- ออเดอร์ที่หักเครดิตแล้ว (write-ahead) ----------

  /**
   * หักเครดิต + บันทึกว่ามีออเดอร์ค้างอยู่ ในการเขียนไฟล์ครั้งเดียว (atomic)
   * ถ้าบอทดับหลังจากนี้ ออเดอร์จะยังอยู่ใน orders ให้กู้/คืนเครดิตตอนเปิดใหม่
   * @returns {{ ok: boolean, balance: number }}
   */
  debitForOrder(userId, amount, ref, meta = {}) {
    WalletStore._checkAmount(amount, 'หัก');
    if (!ref) throw new Error('ต้องมี ref ของออเดอร์');
    const data = this._read();
    if (data.orders[ref]) throw new Error(`ออเดอร์ ${ref} ถูกบันทึกไว้แล้ว`);
    const w = this._ensureWallet(data, userId);
    if (w.balance < amount) return { ok: false, balance: w.balance };
    w.balance = Math.round((w.balance - amount) * 100) / 100;
    this._logTx(data, userId, 'debit', amount, { ...meta, ref });
    data.orders[ref] = { ref, userId, charged: amount, status: 'open', createdAt: new Date().toISOString(), ...meta };
    this._write(data);
    return { ok: true, balance: w.balance };
  }

  /** แก้ข้อมูลออเดอร์ค้าง (เช่น status, ที่อยู่ข้อความหน้าสถานะ) */
  patchOrder(ref, patch) {
    const data = this._read();
    if (!data.orders[ref]) return false;
    Object.assign(data.orders[ref], patch, { updatedAt: new Date().toISOString() });
    this._write(data);
    return true;
  }

  /**
   * สรุปออเดอร์: คืนเครดิต (ถ้า > 0) และลบออกจาก orders ในการเขียนครั้งเดียว
   * ปลอดภัยต่อการเรียกซ้ำ — ถ้าออเดอร์ถูกสรุปไปแล้วจะไม่ทำอะไร (settled: false)
   * @returns {{ settled: boolean, balance: number|null, refunded: number }}
   */
  settleOrder(ref, refundAmount = 0, meta = {}) {
    const data = this._read();
    const order = data.orders[ref];
    if (!order) return { settled: false, balance: null, refunded: 0 };
    const w = this._ensureWallet(data, order.userId);
    let refunded = 0;
    if (typeof refundAmount === 'number' && Number.isFinite(refundAmount) && refundAmount > 0) {
      refunded = Math.min(Math.round(refundAmount * 100) / 100, order.charged); // ห้ามคืนเกินที่หัก
      w.balance = Math.round((w.balance + refunded) * 100) / 100;
      this._logTx(data, order.userId, 'refund', refunded, { ...meta, ref });
    }
    delete data.orders[ref];
    this._write(data);
    return { settled: true, balance: w.balance, refunded };
  }

  listOrders() {
    return Object.values(this._read().orders);
  }

  // ---------- การเติมเครดิตที่กำลังทำ (รับซอง / ตรวจสลิป) ----------

  beginInflight(id, info = {}) {
    const data = this._read();
    data.inflight[id] = { id, ...info, startedAt: new Date().toISOString() };
    this._write(data);
  }

  /** เติมข้อมูลเข้า inflight (เช่น จำนวนเงินที่ได้จากซองแล้ว) */
  patchInflight(id, patch) {
    const data = this._read();
    if (!data.inflight[id]) return false;
    Object.assign(data.inflight[id], patch);
    this._write(data);
    return true;
  }

  endInflight(id) {
    const data = this._read();
    if (!data.inflight[id]) return;
    delete data.inflight[id];
    this._write(data);
  }

  listInflight() {
    return Object.values(this._read().inflight);
  }
}

module.exports = { WalletStore };
