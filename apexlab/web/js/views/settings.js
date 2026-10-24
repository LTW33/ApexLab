import { api } from "../api.js";
import { store } from "../store.js";
import { esc, fmtSize, icon, plural } from "../util.js";
import { setTopbar, toast } from "../ui.js";
import { themeCardsHTML, bindThemeCards } from "../theme.js";
import { channel } from "../channel.js";
import { openImport } from "../importmodal.js";

function pathField(id, label, hint, value, detected) {
  const auto = detected && value && detected === value;
  return `<div class="field">
    <div class="row" style="justify-content:space-between">
      <label for="${id}">${label}</label>
      ${auto ? `<span class="badge lime">найдено автоматически</span>` : ""}
    </div>
    <div class="row">
      <input class="input grow mono" id="${id}" spellcheck="false" value="${esc(value || "")}" placeholder="C:\\...">
      <button class="btn sm ghost" data-reveal-for="${id}" title="Открыть папку в проводнике">${icon("folder", 15)}</button>
    </div>
    <div class="hint">${hint}</div>
  </div>`;
}

function kpi(iconName, label, value, sub) {
  return `<div class="kpi">
    <div class="kpi-label">${icon(iconName, 12)}${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-sub">${sub}</div>
  </div>`;
}

export async function renderSettings(root) {
  await store.load();
  let payload = { settings: store.settings || {}, detected: {} };
  try {
    payload = await api.settings();
  } catch (err) {
    toast(err.message, "err");
  }
  const settings = payload.settings || {};
  const detected = payload.detected || {};
  const stats = store.stats || {};
  const sessions = store.sessions.length;

  setTopbar({
    crumb: "ApexLab",
    title: "Настройки",
    sub: "Папки, библиотека и кэш телеметрии",
    actions: `<button class="btn primary" id="set-import">${icon("upload", 16)}<span>Импорт логов</span></button>`,
  });

  root.innerHTML = `<div class="page" style="display:flex;flex-direction:column;gap:16px">
    <div class="kpi-grid">
      ${kpi("db", "Сессии", String(stats.sessions || 0), `${stats.laps || 0} ${plural(stats.laps || 0, "круг", "круга", "кругов")} в кэше`)}
      ${kpi("check", "Чистые круги", String(stats.clean_laps || 0), `${stats.km ? stats.km.toFixed(0) : 0} км телеметрии`)}
      ${kpi("layers", "Кэш", fmtSize(stats.cache_bytes || 0), `${stats.cache_files || 0} ${plural(stats.cache_files || 0, "файл", "файла", "файлов")}`)}
      ${kpi("info", "Версия", `v${store.appVersion}`, "локально, без интернета")}
    </div>

    <div class="two-col">
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">${icon("folder", 16)}Папки</div>
          <div class="panel-actions"><button class="btn ghost sm" id="set-detect">${icon("refresh", 14)}Определить</button></div>
        </div>
        <div class="panel-body" style="display:flex;flex-direction:column;gap:18px">
          ${pathField("set-acc", "Assetto Corsa Competizione", "Корневая папка игры в документах. Обычно находится автоматически.", settings.acc_path, detected.acc_path)}
          ${pathField("set-motec", "Логи MoTeC (.ld)", "Сюда ACC сохраняет телеметрию. Импорт читает только эту папку.", settings.motec_path, detected.motec_path)}
          ${pathField("set-setups", "Сеты (Setups)", "JSON-сеты ACC. Нужны для рекомендаций «было → стало».", settings.setups_path, detected.setups_path)}
          <div class="hint-box">${icon("info", 16)}<span>Пути можно менять вручную. После сохранения пересканируй логи через «Импорт» — уже добавленные сессии не продублируются.</span></div>
        </div>
        <div class="panel-foot">
          <span class="hint" id="set-status">Изменения применяются сразу</span>
          <div class="row">
            <button class="btn" id="set-scan">${icon("search", 15)}Проверить логи</button>
            <button class="btn primary" id="set-save">${icon("check", 15)}Сохранить</button>
          </div>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="panel">
          <div class="panel-head"><div class="panel-title">${icon("upload", 16)}Импорт</div></div>
          <div class="panel-body" style="display:flex;flex-direction:column;gap:12px">
            <div class="muted" style="font-size:12px;line-height:1.6">
              Приложение читает .ld напрямую, режет на круги по сбросу времени,
              схлопывает дубликаты экспорта и обрывки стендов.
            </div>
            <div class="inline-stats">
              <div class="inline-stat"><div class="k">Формат</div><div class="v">MoTeC .ld</div></div>
              <div class="inline-stat"><div class="k">Шаг сетки</div><div class="v">5 м</div></div>
              <div class="inline-stat"><div class="k">Каналы</div><div class="v">55</div></div>
            </div>
            <button class="btn primary" id="set-import2">${icon("upload", 16)}Импортировать логи</button>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><div class="panel-title">${icon("db", 16)}Библиотека</div></div>
          <div class="panel-body" style="display:flex;flex-direction:column;gap:2px">
            <div class="kv"><span class="k">Сессий</span><span class="v">${sessions}</span></div>
            <div class="kv"><span class="k">Кругов</span><span class="v">${stats.laps || 0}</span></div>
            <div class="kv"><span class="k">Чистых</span><span class="v">${stats.clean_laps || 0}</span></div>
            <div class="kv"><span class="k">Пилотов</span><span class="v">${store.drivers.length}</span></div>
            <div class="kv"><span class="k">Трасс</span><span class="v">${store.tracks().length}</span></div>
            <div class="kv"><span class="k">Кэш</span><span class="v">${fmtSize(stats.cache_bytes || 0)} · ${stats.cache_files || 0} файлов</span></div>
            ${settings.motec_path ? `<button class="btn ghost sm" id="set-reveal-data" style="margin-top:10px;justify-content:flex-start">${icon("folder", 14)}Открыть папку логов</button>` : ""}
          </div>
        </div>
      </div>
    </div>

    <div class="equal-col">
      <div class="panel">
        <div class="panel-head"><div class="panel-title">${icon("zap", 16)}Канал</div>
          <div class="panel-actions"><span class="badge ${channel.isBeta() ? "lime" : "outline"}" id="set-channel-badge">${channel.isBeta() ? "бета" : "релиз"}</span></div>
        </div>
        <div class="panel-body" style="display:flex;flex-direction:column;gap:12px">
          <button class="beta-switch${channel.isBeta() ? " on" : ""}" id="set-channel" type="button" role="switch" aria-checked="${channel.isBeta()}">
            <span class="beta-track"><span class="beta-knob"></span></span>
            <span class="beta-text"><b>Эксперименты</b><small>Новые функции до того, как они попадут в релиз</small></span>
          </button>
          <div class="hint">Релиз получает только исправления и полировку. Бета — новые идеи: они могут вести себя непредсказуемо и меняться между запусками.</div>
          <button class="btn ghost sm" id="set-channel-reset" style="justify-content:flex-start">${icon("refresh", 14)}Как в этой сборке</button>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">${icon("palette", 16)}Оформление</div>
          <div class="panel-sub">7 тем, включая монохромные</div>
        </div>
        <div class="panel-body">${themeCardsHTML()}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">${icon("target", 16)}Целевые окна</div></div>
        <div class="panel-body" style="display:flex;flex-direction:column;gap:2px">
          <div class="kv"><span class="k">Горячее давление</span><span class="v">27.2 psi · GT3</span></div>
          <div class="kv"><span class="k">Горячее давление</span><span class="v">27.0 psi · GT4/TCX</span></div>
          <div class="kv"><span class="k">Тормоза, перед</span><span class="v">до 800 °C</span></div>
          <div class="kv"><span class="k">Тормоза, зад</span><span class="v">до 700 °C</span></div>
          <div class="kv"><span class="k">Шины</span><span class="v">70–95 °C</span></div>
          <div class="kv"><span class="k">Баланс</span><span class="v">около 0</span></div>
          <div class="hint" style="margin-top:8px">Окна — ориентиры для сухой трассы и стабильной погоды.</div>
        </div>
      </div>
    </div>

    <div class="equal-col">
      <div class="panel">
        <div class="panel-head"><div class="panel-title">${icon("alert", 16)}Как читать отчёты</div></div>
        <div class="panel-body muted" style="font-size:12px;line-height:1.7;display:flex;flex-direction:column;gap:10px">
          <p>ACC не пишет имя пилота в MoTeC-лог. Импортируй логи по одному пилоту за раз или переименуй сессию в её карточке.</p>
          <p>Чистый круг — без выезда, пит-лейна и явного контакта. Оценка пилота строится в основном по чистым кругам; если их нет, цифры помечаются как предварительные.</p>
          <p>Рекомендации по сету — не приказ. Меняй один параметр за выезд и смотри, как меняются давления, температуры и баланс.</p>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><div class="panel-title">${icon("keyboard", 16)}Горячие клавиши</div>
          <div class="panel-sub">окно без системной рамки</div>
        </div>
        <div class="panel-body" id="shortcuts">
          <div class="kbd-row"><span>Поиск и команды</span><span class="keys"><kbd>Ctrl</kbd><kbd>K</kbd></span></div>
          <div class="kbd-row"><span>Следующая тема</span><span class="keys"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>T</kbd></span></div>
          <div class="kbd-row"><span>Экспорт отчёта</span><span class="keys"><kbd>Ctrl</kbd><kbd>E</kbd></span></div>
          <div class="kbd-row"><span>Свернуть боковую панель</span><span class="keys"><kbd>Ctrl</kbd><kbd>B</kbd></span></div>
          <div class="kbd-row"><span>Печать страницы</span><span class="keys"><kbd>Ctrl</kbd><kbd>P</kbd></span></div>
          <div class="kbd-row"><span>Вкладки сессии</span><span class="keys"><kbd>Alt</kbd><kbd>1</kbd>…<kbd>5</kbd></span></div>
          <div class="kbd-row"><span>Справка и настройки</span><span class="keys"><kbd>F1</kbd></span></div>
          <div class="kbd-row"><span>Перетащить окно</span><span class="keys"><kbd>заголовок</kbd></span></div>
          <div class="kbd-row"><span>Развернуть / восстановить</span><span class="keys"><kbd>двойной клик</kbd></span></div>
          <div class="hint" style="margin-top:8px">Закрепление окна и кнопки управления — в правом верхнем углу заголовка.</div>
        </div>
      </div>
    </div>
  </div>`;

  bindThemeCards(root);

  const switchEl = root.querySelector("#set-channel");
  const badgeEl = root.querySelector("#set-channel-badge");
  const paintChannel = (beta) => {
    switchEl?.classList.toggle("on", beta);
    switchEl?.setAttribute("aria-checked", String(beta));
    if (badgeEl) {
      badgeEl.textContent = beta ? "бета" : "релиз";
      badgeEl.className = `badge ${beta ? "lime" : "outline"}`;
    }
    const foot = document.querySelector("#sidebar-foot .db-info");
    if (foot) foot.innerHTML = foot.innerHTML.replace(/(· v[\d.]+)( · beta)?$/, `$1${beta ? " · beta" : ""}`);
  };
  switchEl?.addEventListener("click", () => {
    const beta = !channel.isBeta();
    channel.set(beta);
    paintChannel(beta);
    toast(beta ? "Эксперименты включены" : "Эксперименты выключены");
  });
  root.querySelector("#set-channel-reset")?.addEventListener("click", () => {
    const value = channel.reset();
    paintChannel(value === "beta");
    toast(value === "beta" ? "Канал сборки: бета" : "Канал сборки: релиз");
  });

  const top = document.getElementById("topbar");
  top?.querySelector("#set-import")?.addEventListener("click", () => openImport({
    onDone: () => {
      store.invalidate();
      store.load(true).then(() => window.dispatchEvent(new CustomEvent("apex:refresh")));
    },
  }));
  root.querySelector("#set-import2")?.addEventListener("click", () => openImport({
    onDone: () => {
      store.invalidate();
      store.load(true).then(() => window.dispatchEvent(new CustomEvent("apex:refresh")));
    },
  }));

  root.querySelector("#set-detect")?.addEventListener("click", () => {
    if (detected.acc_path) root.querySelector("#set-acc").value = detected.acc_path;
    if (detected.motec_path) root.querySelector("#set-motec").value = detected.motec_path;
    if (detected.setups_path) root.querySelector("#set-setups").value = detected.setups_path;
    toast("Пути найдены автоматически — не забудь сохранить", "info");
  });

  root.querySelectorAll("[data-reveal-for]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const input = root.querySelector(`#${btn.dataset.revealFor}`);
      const path = input?.value?.trim();
      if (!path) { toast("Укажи папку", "info"); return; }
      try {
        await api.reveal(path);
      } catch (err) {
        toast(err.message, "err");
      }
    });
  });

  root.querySelector("#set-save")?.addEventListener("click", async () => {
    const button = root.querySelector("#set-save");
    const status = root.querySelector("#set-status");
    const patch = {
      acc_path: root.querySelector("#set-acc").value.trim(),
      motec_path: root.querySelector("#set-motec").value.trim(),
      setups_path: root.querySelector("#set-setups").value.trim(),
    };
    if (!patch.motec_path) { toast("Путь к логам не может быть пустым", "info"); return; }
    button.disabled = true;
    button.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px"></span>Сохраняю`;
    try {
      const res = await api.saveSettings(patch);
      store.invalidate();
      await store.load(true);
      if (status) status.textContent = "Сохранено";
      toast("Настройки сохранены");
      window.dispatchEvent(new CustomEvent("apex:refresh"));
    } catch (err) {
      toast(err.message, "err");
      button.disabled = false;
      button.innerHTML = `${icon("check", 15)}Сохранить`;
    }
  });

  root.querySelector("#set-scan")?.addEventListener("click", async () => {
    const button = root.querySelector("#set-scan");
    const path = root.querySelector("#set-motec").value.trim();
    button.disabled = true;
    try {
      const data = await api.scan(path);
      const count = data.files?.length || 0;
      const fresh = (data.files || []).filter((f) => !f.imported).length;
      if (!data.exists) toast("Папка не найдена", "err");
      else toast(`Найдено ${count} ${plural(count, "лог", "лога", "логов")}, новых — ${fresh}`);
      const status = root.querySelector("#set-status");
      if (status) status.textContent = data.exists ? `${count} логов в папке` : "Папка не существует";
    } catch (err) {
      toast(err.message, "err");
    } finally {
      button.disabled = false;
    }
  });

  root.querySelector("#set-reveal-data")?.addEventListener("click", async () => {
    try {
      await api.reveal(settings.motec_path);
    } catch (err) {
      toast(err.message, "err");
    }
  });
}
