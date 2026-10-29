'use strict';
/**
 * wallet.js — กระเป๋าเครดิตลูกค้า เก็บลง JSON file
 * รองรับ credit / debit / refund / balance
 * ไม่มี locking ภายในตัว — ต้อง wrap ด้วย mutex/chain จากฝั่งที่เรียก (เช่น withWalletLock ใน customerShop.js)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class WalletStore {
  /**
   * @param {string} file — path ไฟล์ JSON ที่จะเก็บข้อมูล
   */
  constructor(file) {
    this.file = path.resolve(file);
  }

  // ---------- internal ----------
  _read() {
    if (!fs.existsSync(this.file)) return { version: 1, wallets: {}, txLog: [] };
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      throw new Error(`อ่านไฟล์กระเป๋าเครดิตไม่ได้: ${this.file} (${err.code || err.message})`);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`ไฟล์กระเป๋าเครดิต JSON ไม่ถูกต้อง: ${this.file}`);
    }
    if (!data || typeof data !== 'object') {
      throw new Error(`รูปแบบไฟล์กระเป๋าเครดิตไม่ถูกต้อง: ${this.file}`);
    }
    if (!data.wallets || typeof data.wallets !== 'object') data.wallets = {};
    if (!Array.isArray(data.txLog)) data.txLog = [];
    return data;
  }

  _write(data) {
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
      fs.renameSync(tmp, this.file);
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

  // ---------- public API ----------

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

  /**
   * เติมเครดิต (เงินเข้า)
   * @param {string} userId
   * @param {number} amount — จำนวนเงินที่เติม (> 0)
   * @param {object} meta — ข้อมูลเพิ่มเติม เช่น { transRef, source }
   * @returns {number} — ยอดคงเหลือหลังเติม
   */
  credit(userId, amount, meta = {}) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error('จำนวนเงินเติมต้องเป็นตัวเลขมากกว่า 0');
    }
    // กันสลิปซ้ำด้วย transRef
    const data = this._read();
    if (meta.transRef) {
      const dup = data.txLog.find((tx) => tx.type === 'credit' && tx.transRef === meta.transRef);
      if (dup) {
        throw new Error(`สลิป/ซองนี้ถูกใช้ไปแล้ว (transRef: ${meta.transRef})`);
      }
    }
    const w = this._ensureWallet(data, userId);
    w.balance = Math.round((w.balance + amount) * 100) / 100;
    this._logTx(data, userId, 'credit', amount, meta);
    this._write(data);
    return w.balance;
  }

  /**
   * หักเครดิต (เงินออก)
   * @param {string} userId
   * @param {number} amount — จำนวนเงินที่หัก (> 0)
   * @param {object} meta — ข้อมูลเพิ่มเติม
   * @returns {{ ok: boolean, balance: number }}
   */
  debit(userId, amount, meta = {}) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error('จำนวนเงินหักต้องเป็นตัวเลขมากกว่า 0');
    }
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
   * @param {string} userId
   * @param {number} amount — จำนวนที่คืน (> 0)
   * @param {object} meta
   * @returns {number} — ยอดคงเหลือหลังคืน
   */
  refund(userId, amount, meta = {}) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error('จำนวนเงินคืนต้องเป็นตัวเลขมากกว่า 0');
    }
    const data = this._read();
    const w = this._ensureWallet(data, userId);
    w.balance = Math.round((w.balance + amount) * 100) / 100;
    this._logTx(data, userId, 'refund', amount, meta);
    this._write(data);
    return w.balance;
  }
}

module.exports = { WalletStore };
