(function () {
  "use strict";

  const C = window.PMCore;
  const AUTO_LOCK_MS = 5 * 60 * 1000;
  const BACKGROUND_LOCK_MS = 60 * 1000;
  const CLIPBOARD_CLEAR_MS = 30 * 1000;
  const KEY_TABLE = "pm.table";
  const KEY_DATA = "pm.data";

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ 保存

  function load(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function store(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      alert("このiPhoneへの保存に失敗しました。プライベートブラウズでは使えません。");
      return false;
    }
  }

  let table = load(KEY_TABLE);
  let data = (() => {
    try {
      const d = JSON.parse(load(KEY_DATA));
      if (d && Array.isArray(d.sites)) return d;
    } catch { /* 壊れていれば初期化 */ }
    return { check: null, sites: [] };
  })();
  let masterKey = null;

  function saveData() {
    data.sites.sort(C.compareSites);
    store(KEY_DATA, JSON.stringify(data));
  }

  // ------------------------------------------------------------ 画面切り替え

  function showView() {
    for (const id of ["view-setup", "view-lock", "view-main"]) $(id).hidden = true;
    if (!table) {
      $("view-setup").hidden = false;
    } else if (!masterKey) {
      $("view-lock").hidden = false;
      $("lock-status").textContent = data.check ? `確認コード ${data.check} のマスターパスワードを入力` : "";
    } else {
      $("view-main").hidden = false;
      $("check-label").textContent = `確認コード ${data.check ?? "-"}`;
      renderList();
    }
  }

  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  function closeDialogs() {
    for (const d of document.querySelectorAll("dialog[open]")) {
      if (d.id !== "dlg-scan") d.close();
    }
  }
  for (const btn of document.querySelectorAll("[data-close]")) {
    btn.addEventListener("click", () => btn.closest("dialog").close());
  }
  // シートの外側（背景）をタップしたら閉じる
  for (const d of document.querySelectorAll("dialog.sheet")) {
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  }

  // ------------------------------------------------------------ ロック

  $("lock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const master = $("master").value;
    if (!master) return;
    const btn = $("unlock-btn");
    btn.disabled = true;
    $("lock-status").textContent = "鍵を計算中…";
    try {
      const key = await C.deriveMasterKey(master, table);
      const code = await C.checkCode(key);
      if (!data.check) {
        if (!confirm(`確認コードは「${code}」です。\nPC版の確認コードと同じですか？\n（違う場合はマスターパスワードの打ち間違いです）`)) {
          $("lock-status").textContent = "もう一度入力してください";
          return;
        }
        data.check = code;
        saveData();
      } else if (data.check !== code) {
        if (!confirm(`確認コードが登録時（${data.check}）と違います（今回 ${code}）。\nマスターパスワードの打ち間違いの可能性があります。\n続行しますか？`)) {
          $("lock-status").textContent = "もう一度入力してください";
          return;
        }
      }
      masterKey = key;
      $("master").value = "";
      $("master").blur();
      touch();
      showView();
    } catch (err) {
      $("lock-status").textContent = "エラー: " + err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function lock() {
    masterKey = null;
    current = null;
    closeDialogs();
    $("search").value = "";
    showView();
  }
  $("btn-lock").addEventListener("click", lock);

  let idleTimer = null;
  function touch() {
    clearTimeout(idleTimer);
    if (masterKey) idleTimer = setTimeout(lock, AUTO_LOCK_MS);
  }
  for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, touch, true);

  let hiddenAt = null;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt && Date.now() - hiddenAt > BACKGROUND_LOCK_MS && masterKey) {
      lock();
    }
  });

  // ------------------------------------------------------------ 一覧

  function renderList() {
    const q = $("search").value.trim().toLowerCase();
    const list = $("list");
    list.replaceChildren();
    let shown = 0;
    data.sites.forEach((s, i) => {
      const hay = [s.site, s.domain, s.memo].join(" ").toLowerCase();
      if (q && !hay.includes(q)) return;
      shown++;
      const li = document.createElement("li");
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = s.site;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = [s.domain, s.memo].filter(Boolean).join("　") || " ";
      li.append(name, meta);
      li.addEventListener("click", () => openDetail(i));
      list.append(li);
    });
    $("count").textContent = q ? `${shown} / ${data.sites.length} 件` : `${data.sites.length} 件`;
    $("empty").hidden = data.sites.length > 0;
  }
  $("search").addEventListener("input", renderList);

  // ------------------------------------------------------------ パスワード表示

  let current = null; // { index, password }
  let revealed = false;

  function setPwDisplay() {
    $("detail-pw").textContent = !current?.password
      ? "計算中…"
      : revealed ? current.password : "•".repeat(Math.min(current.password.length, 16));
    $("detail-show").textContent = revealed ? "隠す" : "表示";
  }

  async function openDetail(index) {
    const s = data.sites[index];
    current = { index, password: null };
    revealed = false;
    $("detail-site").textContent = s.site;
    $("detail-domain").textContent = s.domain;
    $("detail-meta").textContent = `${s.length}文字・記号 ${s.symbols || "なし"}・世代 ${s.generation}`;
    $("detail-memo").textContent = s.memo;
    setPwDisplay();
    if (!$("dlg-detail").open) $("dlg-detail").showModal();
    const pw = await C.generatePassword(masterKey, s.site, s.length, s.symbols, s.generation);
    if (current && current.index === index) {
      current.password = pw;
      setPwDisplay();
    }
  }

  $("dlg-detail").addEventListener("close", () => { current = null; });
  $("detail-show").addEventListener("click", () => { revealed = !revealed; setPwDisplay(); });

  let clipTimer = null;
  $("detail-copy").addEventListener("click", async () => {
    if (!current?.password) return;
    try {
      await navigator.clipboard.writeText(current.password);
      toast("コピーしました");
      clearTimeout(clipTimer);
      // iOS では画面操作なしに消去できないことがあるため、失敗は無視する
      clipTimer = setTimeout(() => navigator.clipboard.writeText("").catch(() => {}), CLIPBOARD_CLEAR_MS);
    } catch {
      revealed = true;
      setPwDisplay();
      toast("コピーできませんでした。表示した文字を長押ししてコピーしてください");
    }
  });

  $("detail-bump").addEventListener("click", () => {
    const s = data.sites[current.index];
    if (!confirm(`「${s.site}」のパスワードを新しいものに変更します。\nサイト側でもパスワード変更を行ってください。続行しますか？`)) return;
    s.generation += 1;
    saveData();
    renderList();
    openDetail(data.sites.indexOf(s));
  });

  $("detail-delete").addEventListener("click", () => {
    const s = data.sites[current.index];
    if (!confirm(`「${s.site}」を一覧から削除しますか？`)) return;
    data.sites.splice(current.index, 1);
    saveData();
    $("dlg-detail").close();
    renderList();
  });

  // ------------------------------------------------------------ 追加・編集

  let editing = null; // 編集中の index（追加なら null）

  function syncSymbolsField() {
    $("f-symbols").disabled = !$("f-use-symbols").checked;
  }
  $("f-use-symbols").addEventListener("change", syncSymbolsField);
  $("f-symbols-default").addEventListener("click", () => { $("f-symbols").value = C.DEFAULT_SYMBOLS; });

  function openEdit(index) {
    editing = index;
    const s = index == null ? null : data.sites[index];
    $("edit-title").textContent = s ? "サイトの編集" : "サイトの追加";
    $("f-site").value = s?.site ?? "";
    $("f-domain").value = s?.domain ?? "";
    $("f-length").value = s?.length ?? 16;
    $("f-generation").value = s?.generation ?? 1;
    $("f-use-symbols").checked = s ? Boolean(s.symbols) : true;
    $("f-symbols").value = s?.symbols || C.DEFAULT_SYMBOLS;
    $("f-memo").value = s?.memo ?? "";
    syncSymbolsField();
    $("dlg-edit").showModal();
  }
  $("btn-add").addEventListener("click", () => openEdit(null));
  $("detail-edit").addEventListener("click", () => {
    const index = current.index;
    $("dlg-detail").close();
    openEdit(index);
  });

  $("edit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const useSymbols = $("f-use-symbols").checked;
    const symbols = useSymbols ? C.normalizeSymbols($("f-symbols").value) : "";
    if (useSymbols && !symbols) return alert("記号セットに記号が含まれていません");
    let entry;
    try {
      entry = C.cleanEntry({
        site: $("f-site").value, domain: $("f-domain").value,
        length: $("f-length").value, symbols, generation: $("f-generation").value,
        memo: $("f-memo").value,
      });
    } catch {
      return alert(`サイト名を入力し、文字数は ${C.MIN_LENGTH}〜${C.MAX_LENGTH}、世代は1以上にしてください`);
    }

    const key = C.normalizeSite(entry.site);
    const dup = data.sites.some((s, i) => i !== editing && C.normalizeSite(s.site) === key);
    if (dup && !confirm(`サイト名「${entry.site}」は既に登録されています。\n別アカウントの場合は「Google/仕事用」のように区別するのがおすすめです。\n\nこのまま保存しますか？`)) return;

    if (editing != null) {
      const old = data.sites[editing];
      const changed = C.normalizeSite(old.site) !== key || C.PASSWORD_KEYS.some((k) => old[k] !== entry[k]);
      if (changed && !confirm("サイト名・文字数・記号セット・世代のいずれかを変更したため、\n生成されるパスワードが変わります。\n（サイト側のパスワードも変更する場合のみ続行してください）\n\n保存しますか？")) return;
      data.sites[editing] = entry;
    } else {
      data.sites.push(entry);
    }
    saveData();
    $("dlg-edit").close();
    renderList();
    openDetail(data.sites.indexOf(entry));
  });

  // ------------------------------------------------------------ 設定

  $("btn-settings").addEventListener("click", () => {
    $("settings-check").textContent = `確認コード：${data.check ?? "-"}　サイト ${data.sites.length} 件`;
    $("dlg-settings").showModal();
  });

  function applyIncoming(incoming) {
    if (!incoming || !Array.isArray(incoming.sites)) throw new Error("サイト一覧の形式ではありません");
    if (incoming.check && data.check && incoming.check !== data.check &&
        !confirm(`読み込む一覧の確認コード（${incoming.check}）がこのiPhone（${data.check}）と違います。\n別のマスターパスワードや暗号表で作られた一覧の可能性があります。\n続行しますか？`)) return;
    const { merged, added, changed, pwChanged } = C.mergeSites(data.sites, incoming.sites);
    if (!added.length && !changed.length && !pwChanged.length) return alert("変更はありませんでした");
    let msg = `追加：${added.length}件\nメモ等の更新：${changed.length}件`;
    if (pwChanged.length) msg += `\nパスワードが変わる更新：${pwChanged.length}件\n　${pwChanged.join("、")}`;
    if (!confirm(msg + "\n\n反映しますか？")) return;
    data.sites = merged;
    if (!data.check && incoming.check) data.check = incoming.check;
    saveData();
    renderList();
    toast("読み込みました");
  }

  $("s-scan-sites").addEventListener("click", async () => {
    $("dlg-settings").close();
    const payload = await scanQr("S", "サイト一覧を読み取り中");
    if (payload == null) return;
    try { applyIncoming(JSON.parse(payload)); } catch (err) { alert("読み込みエラー：" + err.message); }
  });

  $("s-import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    $("dlg-settings").close();
    try { applyIncoming(JSON.parse(await file.text())); } catch (err) { alert("読み込みエラー：" + err.message); }
  });

  $("s-export").addEventListener("click", async () => {
    const json = JSON.stringify(data, null, 2);
    const file = new File([json], "sites_export.json", { type: "application/json" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (err) {
      if (err.name === "AbortError") return;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });

  $("s-rescan-table").addEventListener("click", async () => {
    if (!confirm("暗号表を読み取り直します。\n違う暗号表を読み込むと、すべてのパスワードが変わります。\n続行しますか？")) return;
    $("dlg-settings").close();
    await scanTable();
  });

  $("s-reset").addEventListener("click", () => {
    if (!confirm("このiPhoneに保存した暗号表とサイト一覧をすべて消します。\n（PC版のデータは消えません）\n続行しますか？")) return;
    if (!confirm("本当に消しますか？")) return;
    try {
      localStorage.removeItem(KEY_TABLE);
      localStorage.removeItem(KEY_DATA);
    } catch { /* 無視 */ }
    location.reload();
  });

  // ------------------------------------------------------------ 暗号表の読み込み

  async function scanTable() {
    const payload = await scanQr("T", "暗号表を読み取り中");
    if (payload == null) return;
    const newTable = C.normalizeTable(payload);
    if (!C.isValidTable(newTable)) return alert("暗号表の形式が正しくありません");
    if (table && newTable !== C.normalizeTable(table)) {
      if (!confirm("以前と違う暗号表です。すべてのパスワードが変わります。\n置き換えますか？")) return;
      data.check = null;
      saveData();
    }
    if (!store(KEY_TABLE, newTable)) return;
    table = newTable;
    masterKey = null;
    alert("暗号表を読み込みました。\nマスターパスワードでロックを解除し、確認コードがPC版と同じことを確かめてください。");
    showView();
  }
  $("setup-scan").addEventListener("click", scanTable);

  // ------------------------------------------------------------ QR 読み取り

  // 分割QRをすべて読み取り、ハッシュを検証した本体を返す（キャンセル時は null）
  function scanQr(kind, title) {
    return new Promise(async (resolve) => {
      const dlg = $("dlg-scan");
      const video = $("scan-video");
      const canvas = $("scan-canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const status = $("scan-status");
      const dots = $("scan-dots");
      const decoder = new TextDecoder();
      let stream = null, timer = null, done = false;
      let parts = {}, total = 0, digest = null;

      $("scan-title").textContent = title;
      status.textContent = "PC画面のQRコードにカメラを向けてください";
      dots.replaceChildren();
      dlg.showModal();

      function finish(result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (stream) stream.getTracks().forEach((t) => t.stop());
        video.srcObject = null;
        dlg.close();
        resolve(result);
      }
      $("scan-cancel").onclick = () => finish(null);
      dlg.oncancel = (e) => { e.preventDefault(); finish(null); };

      function renderDots() {
        dots.replaceChildren(...Array.from({ length: total }, (_, i) => {
          const s = document.createElement("span");
          s.textContent = i + 1;
          if (parts[i + 1] != null) s.className = "done";
          return s;
        }));
      }

      async function onChunk(chunk) {
        if (chunk.kind !== kind) {
          status.textContent = kind === "T" ? "これは暗号表のQRコードではありません" : "これはサイト一覧のQRコードではありません";
          return;
        }
        if (chunk.digest !== digest) { // 別の一覧に切り替わったらやり直し
          parts = {};
          digest = chunk.digest;
          total = chunk.total;
        }
        if (parts[chunk.index] != null) return;
        parts[chunk.index] = chunk.payload;
        if (navigator.vibrate) navigator.vibrate(30);
        renderDots();
        const got = Object.keys(parts).length;
        if (got < total) {
          status.textContent = `${got} / ${total} 枚読み取り済み。PCで「次へ」を押してください`;
          return;
        }
        const payload = Array.from({ length: total }, (_, i) => parts[i + 1]).join("");
        if ((await C.sha256Hex(payload)).slice(0, 8) !== digest) {
          parts = {};
          renderDots();
          status.textContent = "データが一致しません。最初から読み取り直してください";
          return;
        }
        finish(payload);
      }

      async function tick() {
        if (done) return;
        if (video.readyState >= 2 && video.videoWidth) {
          // 中央の正方形を切り出して解析（処理を軽くするため縮小）
          const side = Math.min(video.videoWidth, video.videoHeight);
          const size = Math.min(side, 720);
          canvas.width = canvas.height = size;
          ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, size, size);
          const img = ctx.getImageData(0, 0, size, size);
          const code = window.jsQR(img.data, size, size, { inversionAttempts: "dontInvert" });
          if (code) {
            const chunk = C.parseQrChunk(decoder.decode(new Uint8Array(code.binaryData)));
            if (chunk) await onChunk(chunk);
          }
        }
        timer = setTimeout(tick, 120);
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 1280 } },
          audio: false,
        });
        if (done) return stream.getTracks().forEach((t) => t.stop());
        video.srcObject = stream;
        await video.play();
        tick();
      } catch (err) {
        status.textContent = "カメラを起動できません。設定でカメラへのアクセスを許可してください。";
      }
    });
  }

  // ------------------------------------------------------------ 起動

  const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  $("setup-standalone").hidden = standalone;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  showView();
})();
