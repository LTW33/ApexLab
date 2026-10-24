/* Import wizard: scan the MoTeC folder, pick .ld files, assign a driver. */
import { api } from "./api.js";
import { store } from "./store.js";
import {
  esc, fmtSize, fmtDate, fmtClock, fmtShort, icon, plural,
} from "./util.js";
import { openModal, toast } from "./ui.js";

const CHUNK = 3;

export function openImport({ onDone } = {}) {
  const state = {
    folder: store.settings?.motec_path || "",
    files: [],
    selected: new Set(),
    driver: "",
    importing: false,
    scanned: false,
    finished: false,
    notified: false,
  };

  const modal = openModal({
    title: "Импорт телеметрии",
    sub: "Assetto Corsa Competizione · логи MoTeC (.ld)",
    body: `
      <div class="field">
        <label for="imp-folder">Папка с логами</label>
        <div class="row">
          <div class="input-group grow">${icon("folder", 15)}<input class="input" id="imp-folder" spellcheck="false" placeholder="D:\\...\\MoTeC"></div>
          <button class="btn" id="imp-scan">${icon("refresh", 15)}Проверить</button>
        </div>
        <div class="hint" id="imp-folder-hint">Ищу файлы .ld</div>
      </div>
      <div class="field">
        <label for="imp-driver">Пилот для этих логов</label>
        <input class="input" id="imp-driver" placeholder="Например, Иван" autocomplete="off" maxlength="40">
        <div class="hint">В .ld нет имени пилота — укажи его здесь, потом можно поменять.</div>
      </div>
      <div class="row" style="justify-content:space-between">
        <label class="check-all" id="imp-all"><span class="check" data-all-box>${icon("check", 11)}</span><span>Выбрать все новые</span></label>
        <span class="hint" id="imp-summary">—</span>
      </div>
      <div class="file-list" id="imp-files">
        <div class="loading" style="padding:34px 12px"><div class="spinner"></div><span>Читаю папку…</span></div>
      </div>
      <div class="progress" id="imp-progress"><i></i></div>
    `,
    footer: `
      <span class="hint" id="imp-hint">Файлы с одинаковой телеметрией схлопнутся автоматически</span>
      <div class="row">
        <button class="btn ghost" data-close>Отмена</button>
        <button class="btn primary" id="imp-run" disabled>${icon("upload", 16)}Импортировать</button>
      </div>`,
    onMount(wrap, close) {
      const box = wrap;
      const inputFolder = box.querySelector("#imp-folder");
      const inputDriver = box.querySelector("#imp-driver");
      const listEl = box.querySelector("#imp-files");
      const summaryEl = box.querySelector("#imp-summary");
      const hintEl = box.querySelector("#imp-hint");
      const folderHint = box.querySelector("#imp-folder-hint");
      const allEl = box.querySelector("#imp-all");
      const allBox = box.querySelector("[data-all-box]");
      const runBtn = box.querySelector("#imp-run");
      const progressEl = box.querySelector("#imp-progress");
      const bar = progressEl.querySelector("i");

      inputFolder.value = state.folder;
      inputDriver.value = state.driver;

      function pickable() {
        return state.files.filter((f) => !f.imported);
      }

      function summarize() {
        const chosen = state.files.filter((f) => state.selected.has(f.path));
        const bytes = chosen.reduce((a, f) => a + (f.size || 0), 0);
        const imported = state.files.length - pickable().length;
        summaryEl.textContent = state.files.length
          ? `${chosen.length} из ${state.files.length}${imported ? ` · ${imported} уже в базе` : ""}${chosen.length ? ` · ${fmtSize(bytes)}` : ""}`
          : "нет файлов";
        const all = pickable();
        const on = all.length > 0 && all.every((f) => state.selected.has(f.path));
        allBox.classList.toggle("on", on);
        allBox.innerHTML = on ? icon("check", 11) : "";
        runBtn.disabled = state.importing || chosen.length === 0;
      }

      function rowHTML(f) {
        const sel = state.selected.has(f.path);
        const when = [fmtDate(f.date), fmtClock(f.time)].filter(Boolean).join(" · ");
        return `<div class="file-row${f.imported ? " imported" : ""}" data-path="${esc(f.path)}">
          <span class="check${sel ? " on" : ""}">${sel ? icon("check", 11) : ""}</span>
          <span class="name">${esc(f.track || f.name)}<span class="sub">${esc(f.car || "")}</span></span>
          <span class="meta">${esc(when || "—")}</span>
          <span class="meta">${f.imported ? "в библиотеке" : fmtSize(f.size)}</span>
        </div>`;
      }

      function renderFiles() {
        if (!state.files.length) {
          listEl.innerHTML = `<div class="empty" style="padding:30px 16px">
            <div class="empty-icon">${icon("folder", 22)}</div>
            <h3>Файлов не найдено</h3>
            <p>${esc(folderHint.textContent || "В папке нет логов .ld.")}</p>
          </div>`;
          summarize();
          return;
        }
        listEl.innerHTML = state.files.map(rowHTML).join("");
        summarize();
      }

      function toggle(path) {
        if (state.importing) return;
        const f = state.files.find((x) => x.path === path);
        if (!f || f.imported) return;
        if (state.selected.has(path)) state.selected.delete(path);
        else state.selected.add(path);
        renderFiles();
      }

      listEl.addEventListener("click", (ev) => {
        const row = ev.target.closest(".file-row");
        if (row) toggle(row.dataset.path);
      });

      allEl.addEventListener("click", () => {
        if (state.importing) return;
        const all = pickable();
        const on = all.length > 0 && all.every((f) => state.selected.has(f.path));
        state.selected.clear();
        if (!on) all.forEach((f) => state.selected.add(f.path));
        renderFiles();
      });

      inputFolder.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") scan();
      });
      box.querySelector("#imp-scan").addEventListener("click", scan);
      inputDriver.addEventListener("input", () => { state.driver = inputDriver.value; });

      async function scan() {
        if (state.importing) return;
        state.folder = inputFolder.value.trim();
        folderHint.textContent = "Читаю папку…";
        listEl.innerHTML = `<div class="loading" style="padding:34px 12px"><div class="spinner"></div><span>Читаю папку…</span></div>`;
        try {
          const data = await api.scan(state.folder);
          state.files = data.files || [];
          state.scanned = true;
          const fresh = state.files.filter((f) => !f.imported);
          state.selected = new Set(fresh.map((f) => f.path));
          const folder = data.folder || state.folder;
          state.folder = folder;
          inputFolder.value = folder;
          if (!data.exists) {
            folderHint.textContent = "Папка не существует — проверь путь.";
          } else if (!state.files.length) {
            folderHint.textContent = "В этой папке нет файлов .ld.";
          } else {
            const imported = state.files.length - fresh.length;
            folderHint.textContent = `${state.files.length} ${plural(state.files.length, "лог", "лога", "логов")}${imported ? `, ${imported} уже в библиотеке` : ""}`;
          }
          renderFiles();
        } catch (err) {
          folderHint.textContent = String(err?.message || err);
          state.files = [];
          renderFiles();
          toast(String(err?.message || err), "err");
        }
      }

      function setProgress(pct, text) {
        progressEl.style.display = pct == null ? "none" : "block";
        bar.style.width = `${Math.round((pct || 0) * 100)}%`;
        if (text) hintEl.textContent = text;
      }

      async function run() {
        if (state.importing) return;
        const paths = state.files.filter((f) => state.selected.has(f.path)).map((f) => f.path);
        if (!paths.length) {
          toast("Выбери хотя бы один лог", "info");
          return;
        }
        state.importing = true;
        state.driver = inputDriver.value.trim();
        runBtn.disabled = true;
        runBtn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px"></span>Обрабатываю…`;
        box.querySelectorAll("[data-close]").forEach((b) => b.setAttribute("disabled", "disabled"));
        setProgress(0, `Готовлю ${paths.length} ${plural(paths.length, "лог", "лога", "логов")}…`);

        const added = [];
        const skipped = [];
        for (let i = 0; i < paths.length; i += CHUNK) {
          const part = paths.slice(i, i + CHUNK);
          const done = Math.min(i, paths.length);
          setProgress(done / paths.length, `Разбираю телеметрию: ${done} из ${paths.length}`);
          try {
            const res = await api.importFiles(part, state.driver);
            added.push(...(res.added || []));
            skipped.push(...(res.skipped || []));
          } catch (err) {
            skipped.push({ file: part.join(", "), reason: String(err?.message || err) });
          }
          setProgress(Math.min(i + CHUNK, paths.length) / paths.length,
            `Разбираю телеметрию: ${Math.min(i + CHUNK, paths.length)} из ${paths.length}`);
        }
        setProgress(1, "Готово");
        state.importing = false;
        state.finished = true;

        if (!state.notified) {
          state.notified = true;
          onDone?.();
        }
        renderResult(added, skipped);
      }

      function renderResult(added, skipped) {
        const body = box.querySelector(".modal-body");
        const foot = box.querySelector(".modal-foot");
        if (!body || !foot) return;

        const addedHTML = added.length
          ? added.map((s) => `<div class="file-row imported" style="opacity:1;cursor:default">
              <span class="check on">${icon("check", 11)}</span>
              <span class="name">${esc(s.track)}<span class="sub">${esc(s.car)} · ${esc(s.driver || "Пилот")}</span></span>
              <span class="meta">${s.clean_laps || 0} ${plural(s.clean_laps || 0, "чистый", "чистых", "чистых")}</span>
              <span class="meta">${fmtShort(s.best_time)}</span>
            </div>`).join("")
          : "";

        const reasons = new Map();
        for (const item of skipped) {
          const key = item.reason || "неизвестная причина";
          if (!reasons.has(key)) reasons.set(key, []);
          reasons.get(key).push(item.file || "");
        }
        const skippedHTML = [...reasons.entries()].map(([reason, files]) => `<div class="file-row imported" style="opacity:1;cursor:default">
            <span class="check">${icon("alert", 11)}</span>
            <span class="name">${esc(files.map((p) => p.split(/[\\/]/).pop()).join(", "))}<span class="sub">${esc(reason)}</span></span>
            <span class="meta">${files.length}</span>
          </div>`).join("");

        body.innerHTML = `
          <div class="inline-stats">
            <div class="inline-stat"><div class="k">Добавлено</div><div class="v lime">${added.length}</div></div>
            <div class="inline-stat"><div class="k">Пропущено</div><div class="v">${skipped.length}</div></div>
            <div class="inline-stat"><div class="k">Пилот</div><div class="v">${esc(state.driver || "Пилот")}</div></div>
          </div>
          ${added.length ? `<div>
            <div class="label" style="margin-bottom:8px">Новые сессии</div>
            <div class="file-list">${addedHTML}</div>
          </div>` : `<div class="hint-box warn">${icon("alert", 16)}<span>Ничего не добавлено. Возможно, эти логи уже есть в библиотеке или в них нет пригодной телеметрии.</span></div>`}
          ${skippedHTML ? `<div>
            <div class="label" style="margin-bottom:8px">Пропуски</div>
            <div class="file-list">${skippedHTML}</div>
          </div>` : ""}
        `;
        foot.innerHTML = `
          <span class="hint">${added.length ? "Библиотека обновлена" : "Можно выбрать другие файлы"}</span>
          <div class="row">
            <button class="btn" data-again>${icon("refresh", 15)}Ещё раз</button>
            <button class="btn primary" data-done>Готово</button>
          </div>`;
        foot.querySelector("[data-done]").addEventListener("click", () => close());
        foot.querySelector("[data-again]").addEventListener("click", () => {
          close();
          setTimeout(() => openImport({ onDone }), 80);
        });
      }

      runBtn.addEventListener("click", run);
      scan();
    },
  });

  return modal;
}
