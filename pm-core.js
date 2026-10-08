// passmanager.py と同じ計算をする中核部分。
// 同じ入力から PC 版と 1 文字も違わないパスワードを出すこと（test-vectors で確認）。
(function (root) {
  "use strict";

  const LOWER = "abcdefghijklmnopqrstuvwxyz";
  const UPPER = LOWER.toUpperCase();
  const DIGITS = "0123456789";
  const PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"; // Python の string.punctuation
  const DEFAULT_SYMBOLS = "!@#$%^&*-_=+?";
  const TABLE_ALPHABET = LOWER + UPPER + DIGITS + DEFAULT_SYMBOLS;

  const PBKDF2_ITERATIONS = 600000;
  const MIN_LENGTH = 8;
  const MAX_LENGTH = 64;
  const QR_PREFIX = "PMQR1";
  const PASSWORD_KEYS = ["length", "symbols", "generation"];

  const subtle = globalThis.crypto.subtle;
  const utf8 = new TextEncoder();

  function toHex(buf) {
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function sha256Hex(text) {
    return toHex(await subtle.digest("SHA-256", utf8.encode(text)));
  }

  function normalizeTable(text) {
    return text.split(/\s+/).join("");
  }

  function isValidTable(table) {
    return table.length >= 256 && [...table].every((c) => TABLE_ALPHABET.includes(c));
  }

  // PBKDF2(マスターパスワード, SHA256(暗号表)) → HMAC 用の鍵
  async function deriveMasterKey(masterPassword, tableText) {
    const salt = await subtle.digest("SHA-256", utf8.encode(normalizeTable(tableText)));
    const base = await subtle.importKey("raw", utf8.encode(masterPassword), "PBKDF2", false, ["deriveBits"]);
    const bits = await subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, base, 256);
    return subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }

  async function checkCode(masterKey) {
    return toHex(await subtle.sign("HMAC", masterKey, utf8.encode("check"))).slice(0, 6);
  }

  function normalizeSite(site) {
    return site.trim().toLowerCase();
  }

  function normalizeSymbols(symbols) {
    return [...new Set([...symbols].filter((c) => PUNCTUATION.includes(c)))].sort().join("");
  }

  function normalizeDomain(domain) {
    domain = domain.trim().toLowerCase();
    if (!domain) return "";
    try {
      const host = new URL(domain.includes("://") ? domain : "http://" + domain).hostname;
      return host.startsWith("www.") ? host.slice(4) : host;
    } catch {
      return "";
    }
  }

  // Python の json.dumps（ensure_ascii=True）と同じ文字列表現
  function pyJsonString(s) {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const code = s.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === "\\") out += "\\\\";
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else if (c === "\b") out += "\\b";
      else if (c === "\f") out += "\\f";
      else if (code < 0x20 || code > 0x7e) out += "\\u" + code.toString(16).padStart(4, "0");
      else out += c;
    }
    return out + '"';
  }

  // HMAC-SHA256 をカウンターモードで回す決定的な乱数列
  class Stream {
    constructor(key, info) {
      this.key = key;
      this.info = info;
      this.counter = 0;
      this.buf = new Uint8Array(0);
    }

    async bytes(n) {
      while (this.buf.length < n) {
        const msg = new Uint8Array(this.info.length + 4);
        msg.set(this.info);
        new DataView(msg.buffer).setUint32(this.info.length, this.counter);
        const block = new Uint8Array(await subtle.sign("HMAC", this.key, msg));
        const next = new Uint8Array(this.buf.length + block.length);
        next.set(this.buf);
        next.set(block, this.buf.length);
        this.buf = next;
        this.counter++;
      }
      const out = this.buf.slice(0, n);
      this.buf = this.buf.slice(n);
      return out;
    }

    async below(n) {
      const limit = Math.floor(2 ** 32 / n) * n;
      for (;;) {
        const b = await this.bytes(4);
        const x = new DataView(b.buffer).getUint32(0);
        if (x < limit) return x % n;
      }
    }

    async choice(seq) {
      return seq[await this.below(seq.length)];
    }
  }

  async function generatePassword(masterKey, site, length, symbols, generation) {
    site = normalizeSite(site);
    symbols = normalizeSymbols(symbols);
    if (!site) throw new Error("サイト名が空です");
    if (!(length >= MIN_LENGTH && length <= MAX_LENGTH)) {
      throw new Error(`文字数は ${MIN_LENGTH}〜${MAX_LENGTH} にしてください`);
    }
    const info = utf8.encode(`[${pyJsonString(site)}, ${length}, ${pyJsonString(symbols)}, ${generation}]`);
    const stream = new Stream(masterKey, info);

    const classes = [LOWER, UPPER, DIGITS].concat(symbols ? [symbols] : []);
    const all = classes.join("");
    const chars = [];
    for (const c of classes) chars.push(await stream.choice(c));
    while (chars.length < length) chars.push(await stream.choice(all));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = await stream.below(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join("");
  }

  function cleanEntry(entry) {
    const site = String(entry.site ?? "").trim();
    const length = parseInt(entry.length, 10);
    const generation = parseInt(entry.generation, 10);
    if (!site || !(length >= MIN_LENGTH && length <= MAX_LENGTH) || !(generation >= 1)) {
      throw new Error("不正なサイト情報です: " + JSON.stringify(entry));
    }
    return {
      site,
      domain: normalizeDomain(String(entry.domain ?? "")),
      length,
      symbols: normalizeSymbols(String(entry.symbols ?? "")),
      generation,
      memo: String(entry.memo ?? "").trim(),
    };
  }

  function compareSites(a, b) {
    const x = normalizeSite(a.site), y = normalizeSite(b.site);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  // サイト名で突き合わせて統合する。同名で内容が違う場合は読み込んだ側を採用
  function mergeSites(localSites, incomingSites) {
    const merged = localSites.map((s) => ({ ...s }));
    const index = new Map(merged.map((s, i) => [normalizeSite(s.site), i]));
    const added = [], changed = [], pwChanged = [];
    for (const raw of incomingSites) {
      const entry = cleanEntry(raw);
      const key = normalizeSite(entry.site);
      if (!index.has(key)) {
        index.set(key, merged.length);
        merged.push(entry);
        added.push(entry.site);
        continue;
      }
      const old = merged[index.get(key)];
      if (Object.keys(entry).every((k) => old[k] === entry[k])) continue;
      if (PASSWORD_KEYS.some((k) => old[k] !== entry[k])) pwChanged.push(entry.site);
      else changed.push(entry.site);
      merged[index.get(key)] = entry;
    }
    merged.sort(compareSites);
    return { merged, added, changed, pwChanged };
  }

  // "PMQR1:種類:番号:総数:ハッシュ:本体"
  function parseQrChunk(text) {
    const parts = text.split(":");
    if (parts.length < 6 || parts[0] !== QR_PREFIX) return null;
    const [, kind, i, n, digest] = parts;
    const index = parseInt(i, 10), total = parseInt(n, 10);
    if (!(total >= 1 && index >= 1 && index <= total)) return null;
    return { kind, index, total, digest, payload: parts.slice(5).join(":") };
  }

  root.PMCore = {
    DEFAULT_SYMBOLS, MIN_LENGTH, MAX_LENGTH, PASSWORD_KEYS,
    sha256Hex, normalizeTable, isValidTable, deriveMasterKey, checkCode,
    normalizeSite, normalizeSymbols, normalizeDomain, generatePassword,
    cleanEntry, compareSites, mergeSites, parseQrChunk,
  };
})(typeof window !== "undefined" ? window : globalThis);
