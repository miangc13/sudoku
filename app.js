"use strict";

const DIFFS = {
  easy:   { title: "Лёгкий", desc: "Для разминки: много готовых цифр" },
  medium: { title: "Средний", desc: "Нужно немного подумать" },
  hard:   { title: "Сложный", desc: "Для опытных игроков" },
  expert: { title: "Эксперт", desc: "Минимум подсказок на поле" },
};
const STATUS = { active: "Идёт сейчас", upcoming: "Скоро", finished: "Завершено" };
const MAX_HINTS = 3;

const state = { user: null, offset: 0, timer: null, keyHandler: null };
const app = document.getElementById("app");

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}
function fmtDay(ts) {
  return new Date(ts * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}
function nowServer() { return Date.now() / 1000 + state.offset; }

function toast(msg, isErr) {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: {}, credentials: "same-origin" };
  if (opts.body !== undefined) {
    init.method = opts.method || "POST";
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try { res = await fetch("/api" + path, init); }
  catch (e) { throw new Error("Нет связи с сервером. Он запущен?"); }
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (data.server_time) state.offset = data.server_time - Date.now() / 1000;
  if (!res.ok) {
    const err = new Error(data.error || "Ошибка " + res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}

function modal(html) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(ov);
  ov.close = () => ov.remove();
  return ov;
}

function renderHeader() {
  const box = document.getElementById("auth-box");
  if (state.user) {
    box.innerHTML = `<a class="who" href="#/profile">${esc(state.user.username)}${state.user.is_admin ? " (админ)" : ""}</a>
      <button class="btn light small" id="logout">Выйти</button>`;
    document.getElementById("logout").onclick = async () => {
      await api("/logout", { method: "POST", body: {} });
      state.user = null;
      renderHeader();
      location.hash = "#/";
      toast("Вы вышли из аккаунта");
    };
  } else {
    box.innerHTML = `<a class="btn light small" href="#/login">Войти</a><a class="btn small" href="#/register">Регистрация</a>`;
  }
}
function highlightNav(path) {
  document.querySelectorAll("#nav a").forEach(a => {
    const r = a.dataset.route;
    a.classList.toggle("active", path === "/" ? false : path.startsWith(r));
  });
}
async function loadMe() {
  try { state.user = (await api("/me")).user; } catch (e) { state.user = null; }
  renderHeader();
}

const routes = [
  [/^\/$/, pageHome],
  [/^\/play$/, pagePlay],
  [/^\/competitions$/, pageCompetitions],
  [/^\/competition\/(\d+)$/, pageCompetition],
  [/^\/leaderboard$/, pageLeaderboard],
  [/^\/profile(?:\/(.+))?$/, pageProfile],
  [/^\/login$/, pageLogin],
  [/^\/register$/, pageRegister],
];

function stopGameHooks() {
  clearInterval(state.timer);
  if (state.keyHandler) { document.removeEventListener("keydown", state.keyHandler); state.keyHandler = null; }
}

async function router() {
  stopGameHooks();
  const path = decodeURIComponent(location.hash.slice(1) || "/");
  highlightNav(path);
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      app.innerHTML = `<div class="loading">Загрузка…</div>`;
      try { await fn(...m.slice(1)); }
      catch (e) {
        app.innerHTML = `<div class="card center"><h2>Что-то пошло не так</h2><p>${esc(e.message)}</p>
          <a class="btn" href="#/">На главную</a></div>`;
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  app.innerHTML = `<div class="card center"><h2>Страница не найдена</h2><a class="btn" href="#/">На главную</a></div>`;
}

function needLogin(text) {
  app.innerHTML = `<div class="card center" style="max-width:520px;margin:30px auto">
    <h2>Нужен аккаунт</h2>
    <p class="muted">${text}</p>
    <div class="row" style="justify-content:center">
      <a class="btn" href="#/login">Войти</a><a class="btn ghost" href="#/register">Регистрация</a></div></div>`;
}

async function pageHome() {
  const [st, comps, lb] = await Promise.all([
    api("/stats"), api("/competitions"), api("/leaderboard?type=points&period=all"),
  ]);
  const shown = comps.competitions.filter(c => c.status !== "finished").reverse().slice(0, 3);
  app.innerHTML = `
    <section class="hero">
      <h1>Судоку-Лес</h1>
      <p>Решайте судоку на четырёх уровнях сложности, участвуйте в соревнованиях и поднимайтесь в таблице лидеров.</p>
      <div class="actions">
        <a class="btn big" href="#/play">Играть</a>
        <a class="btn big light" href="#/competitions">Соревнования</a>
        ${state.user ? "" : `<a class="btn big light" href="#/register">Создать аккаунт</a>`}
      </div>
    </section>

    <section class="section grid cols-3">
      <div class="card stat-card"><div class="num">${st.players}</div>игроков в лесу</div>
      <div class="card stat-card"><div class="num">${st.games}</div>решённых судоку</div>
      <div class="card stat-card"><div class="num">${st.active_competitions}</div>соревнований идёт сейчас</div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Ближайшие соревнования</h2><a href="#/competitions">Все соревнования →</a></div>
      <div class="grid cols-2">${shown.length ? shown.map(compCard).join("") : `<div class="card empty">Пока нет активных соревнований</div>`}</div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Лучшие игроки</h2><a href="#/leaderboard">Весь рейтинг →</a></div>
      ${leaderTable(lb.rows.slice(0, 5), "points")}
    </section>

    <section class="section grid cols-3">
      <div class="card feature"><h3>Честные пазлы</h3><p class="muted">У каждого судоку единственное решение. Время считает сервер, а не ваш браузер.</p></div>
      <div class="card feature"><h3>Соревнования</h3><p class="muted">Один пазл на всех и одна попытка. Побеждает тот, кто набрал больше очков.</p></div>
      <div class="card feature"><h3>Общий рейтинг</h3><p class="muted">Очки и лучшее время по каждому уровню хранятся в общей базе данных.</p></div>
    </section>`;
}

function compCard(c) {
  const when = c.status === "upcoming" ? `Начало: ${fmtDate(c.start_at)}`
    : c.status === "active" ? `До ${fmtDate(c.end_at)}` : `Закончилось ${fmtDate(c.end_at)}`;
  return `<div class="card comp-card">
    <div class="row"><span class="chip ${c.status}">${STATUS[c.status]}</span>
      <span class="chip diff">${DIFFS[c.difficulty].title}</span></div>
    <h3>${esc(c.title)}</h3>
    <p class="muted" style="margin:0">${esc(c.description || "")}</p>
    <div class="small muted">${when} · участников: ${c.participants ?? 0}</div>
    <div><a class="btn small" href="#/competition/${c.id}">Подробнее</a></div>
  </div>`;
}

function leaderTable(rows, kind) {
  if (!rows.length) return `<div class="card empty">Пока никто не сыграл. Станьте первым!</div>`;
  const me = state.user && state.user.username.toLowerCase();
  const head = kind === "best"
    ? `<th>Игрок</th><th class="num">Лучшее время</th><th class="num">Игр</th>`
    : `<th>Игрок</th><th class="num">Очки</th><th class="num">Игр</th>`;
  const body = rows.map(r => `<tr class="${me && r.username.toLowerCase() === me ? "me" : ""}">
      <td class="rank">${r.rank}</td>
      <td><a href="#/profile/${encodeURIComponent(r.username)}">${esc(r.username)}</a></td>
      <td class="num">${kind === "best" ? fmtTime(r.best) : r.points}</td>
      <td class="num">${r.games}</td></tr>`).join("");
  return `<div class="table-wrap"><table class="tbl"><thead><tr><th>#</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

async function pageLeaderboard() {
  const f = { type: "points", difficulty: "easy", period: "all" };
  app.innerHTML = `<h1>Таблица лидеров</h1>
    <div class="tabs" id="lb-type">
      <button class="tab active" data-v="points">По очкам</button>
      <button class="tab" data-v="best">Лучшее время</button></div>
    <div class="tabs" id="lb-diff" hidden></div>
    <div class="tabs" id="lb-period">
      <button class="tab active" data-v="all">За всё время</button>
      <button class="tab" data-v="week">За неделю</button></div>
    <div id="lb-body"></div>
    <p class="muted small">Очки = сумма очков за все решённые судоку. За каждое судоку: базовые очки уровня + бонус за скорость − штраф за ошибки и подсказки.</p>`;
  const diffBox = document.getElementById("lb-diff");
  diffBox.innerHTML = Object.entries(DIFFS).map(([k, d], i) =>
    `<button class="tab ${i === 0 ? "active" : ""}" data-v="${k}">${d.title}</button>`).join("");

  async function load() {
    diffBox.hidden = f.type !== "best";
    const q = `/leaderboard?type=${f.type}&difficulty=${f.difficulty}&period=${f.period}`;
    const data = await api(q);
    document.getElementById("lb-body").innerHTML = leaderTable(data.rows, f.type);
  }
  function bind(id, key) {
    document.getElementById(id).addEventListener("click", e => {
      const b = e.target.closest(".tab"); if (!b) return;
      f[key] = b.dataset.v;
      document.querySelectorAll(`#${id} .tab`).forEach(t => t.classList.toggle("active", t === b));
      load().catch(err => toast(err.message, true));
    });
  }
  bind("lb-type", "type"); bind("lb-diff", "difficulty"); bind("lb-period", "period");
  await load();
}

async function pageProfile(name) {
  if (!name && !state.user) return needLogin("Войдите, чтобы увидеть свой профиль и историю игр.");
  const p = await api("/profile" + (name ? "?username=" + encodeURIComponent(name) : ""));
  const best = Object.entries(DIFFS).map(([k, d]) => `<div class="card stat-card">
      <div class="small muted">${d.title}</div>
      <div class="num">${p.best[k] != null ? fmtTime(p.best[k]) : "—"}</div><div class="small muted">лучшее время</div></div>`).join("");
  const hist = p.history.length ? `<div class="table-wrap"><table class="tbl"><thead><tr>
      <th>Когда</th><th>Уровень</th><th>Тип</th><th class="num">Время</th><th class="num">Ошибки</th><th class="num">Подсказки</th><th class="num">Очки</th></tr></thead><tbody>
      ${p.history.map(h => `<tr><td>${fmtDate(h.finished_at)}</td><td>${DIFFS[h.difficulty].title}</td>
        <td>${h.competition ? esc(h.competition) : "Свободная игра"}</td>
        <td class="num">${fmtTime(h.seconds)}</td><td class="num">${h.mistakes}</td><td class="num">${h.hints}</td><td class="num"><b>${h.score}</b></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="card empty">Игр пока нет — <a href="#/play">сыграйте первую!</a></div>`;
  app.innerHTML = `
    <div class="card row" style="gap:20px">
      <div class="avatar">${esc(p.username[0].toUpperCase())}</div>
      <div><h1 style="margin:0;font-size:2rem">${esc(p.username)}${p.is_admin ? " (админ)" : ""}</h1>
        <div class="muted">В лесу с ${fmtDay(p.created_at)}</div></div>
      <div class="spacer"></div>
      <div class="row" style="gap:26px">
        <div class="center"><div class="stat-card"><div class="num">${p.points}</div></div><span class="small muted">очков</span></div>
        <div class="center"><div class="stat-card"><div class="num">${p.games}</div></div><span class="small muted">игр</span></div>
        <div class="center"><div class="stat-card"><div class="num">${p.competitions}</div></div><span class="small muted">турниров</span></div>
      </div>
    </div>
    <section class="section"><h2>Рекорды</h2><div class="grid cols-4">${best}</div></section>
    <section class="section"><h2>Последние игры</h2>${hist}</section>`;
}

function authForm(mode) {
  const reg = mode === "register";
  app.innerHTML = `<form class="card form" id="auth-form" autocomplete="on">
    <h2 class="center">${reg ? "Регистрация" : "Вход"}</h2>
    <label for="u">Имя игрока</label>
    <input id="u" name="username" required minlength="3" maxlength="20" autocomplete="username" placeholder="например, Лесник_42">
    <label for="p">Пароль</label>
    <input id="p" name="password" type="password" required minlength="6" autocomplete="${reg ? "new-password" : "current-password"}" placeholder="не короче 6 символов">
    <div class="form-error" id="auth-err"></div>
    <button class="btn" type="submit">${reg ? "Создать аккаунт" : "Войти"}</button>
    <p class="center muted">${reg ? `Уже есть аккаунт? <a href="#/login">Войти</a>` : `Нет аккаунта? <a href="#/register">Зарегистрироваться</a>`}</p>
  </form>`;
  document.getElementById("auth-form").onsubmit = async e => {
    e.preventDefault();
    const err = document.getElementById("auth-err");
    err.textContent = "";
    try {
      const d = await api(reg ? "/register" : "/login", {
        body: { username: document.getElementById("u").value, password: document.getElementById("p").value },
      });
      state.user = d.user;
      renderHeader();
      toast(reg ? "Добро пожаловать в лес!" : "С возвращением, " + d.user.username + "!");
      location.hash = "#/play";
    } catch (ex) { err.textContent = ex.message; }
  };
}
async function pageLogin() { authForm("login"); }
async function pageRegister() { authForm("register"); }

async function pageCompetitions() {
  const { competitions } = await api("/competitions");
  const group = (st, title) => {
    const list = competitions.filter(c => c.status === st);
    return list.length ? `<section class="section"><h2>${title}</h2><div class="grid cols-2">${list.map(compCard).join("")}</div></section>` : "";
  };
  app.innerHTML = `<h1>Соревнования</h1>
    <p class="muted">Все участники получают один и тот же пазл и только одну попытку. Таймер запускается, когда вы нажмёте «Начать», и его нельзя поставить на паузу.</p>
    ${group("active", "Идут сейчас")}${group("upcoming", "Скоро начнутся")}${group("finished", "Завершённые")}
    ${competitions.length ? "" : `<div class="card empty">Соревнований пока нет</div>`}
    ${state.user && state.user.is_admin ? adminForm() : ""}`;
  if (state.user && state.user.is_admin) bindAdminForm();
}

function adminForm() {
  const pad = n => String(n).padStart(2, "0");
  const local = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const s = new Date(), e = new Date(Date.now() + 7 * 86400000);
  return `<section class="section"><form class="card" id="comp-form">
    <h2>Создать соревнование</h2><p class="muted small">Эта форма видна только администратору (первому зарегистрированному игроку).</p>
    <div class="grid cols-2">
      <div><label>Название</label><input id="c-title" required minlength="3" maxlength="60" placeholder="Кубок первого снега"></div>
      <div><label>Уровень сложности</label><select id="c-diff">${Object.entries(DIFFS).map(([k, d]) => `<option value="${k}">${d.title}</option>`).join("")}</select></div>
      <div><label>Начало</label><input id="c-start" type="datetime-local" required value="${local(s)}"></div>
      <div><label>Окончание</label><input id="c-end" type="datetime-local" required value="${local(e)}"></div>
    </div>
    <label>Описание</label><textarea id="c-desc" rows="2" maxlength="300" placeholder="Коротко о правилах и призах"></textarea>
    <div class="form-error" id="c-err"></div>
    <button class="btn" style="margin-top:16px">Создать</button></form></section>`;
}
function bindAdminForm() {
  document.getElementById("comp-form").onsubmit = async e => {
    e.preventDefault();
    const err = document.getElementById("c-err"); err.textContent = "";
    try {
      const d = await api("/competitions", { body: {
        title: document.getElementById("c-title").value,
        description: document.getElementById("c-desc").value,
        difficulty: document.getElementById("c-diff").value,
        start_at: Math.floor(new Date(document.getElementById("c-start").value).getTime() / 1000),
        end_at: Math.floor(new Date(document.getElementById("c-end").value).getTime() / 1000),
      } });
      toast("Соревнование создано!");
      location.hash = "#/competition/" + d.id;
    } catch (ex) { err.textContent = ex.message; }
  };
}

async function pageCompetition(id) {
  const d = await api("/competitions/" + id);
  const c = d.competition;
  const me = state.user && state.user.username.toLowerCase();
  let action = "";
  if (c.status === "active") {
    if (!state.user) action = `<a class="btn big" href="#/login">Войдите, чтобы участвовать</a>`;
    else if (d.my && d.my.status === "done") action = `<div class="chip active">Вы уже участвовали</div>`;
    else action = `<button class="btn big" id="start-comp">${d.my ? "Продолжить" : "Начать"}</button>`;
  } else if (c.status === "upcoming") action = `<div class="chip upcoming">Начало: ${fmtDate(c.start_at)}</div>`;
  const rows = d.results.length ? `<div class="table-wrap"><table class="tbl"><thead><tr>
      <th>#</th><th>Игрок</th><th class="num">Очки</th><th class="num">Время</th><th class="num">Ошибки</th><th class="num">Подсказки</th></tr></thead><tbody>
      ${d.results.map(r => `<tr class="${me && r.username.toLowerCase() === me ? "me" : ""}">
        <td class="rank">${r.rank}</td>
        <td><a href="#/profile/${encodeURIComponent(r.username)}">${esc(r.username)}</a></td>
        <td class="num"><b>${r.score}</b></td><td class="num">${fmtTime(r.seconds)}</td>
        <td class="num">${r.mistakes}</td><td class="num">${r.hints}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="card empty">Результатов пока нет. Станьте первым!</div>`;
  app.innerHTML = `<a href="#/competitions">← Все соревнования</a>
    <div class="card" style="margin-top:12px">
      <div class="row"><span class="chip ${c.status}">${STATUS[c.status]}</span>
        <span class="chip diff">${DIFFS[c.difficulty].title}</span></div>
      <h1 style="margin-top:10px">${esc(c.title)}</h1>
      <p>${esc(c.description || "")}</p>
      <p class="muted small">${fmtDate(c.start_at)} — ${fmtDate(c.end_at)} · участников: ${c.participants} · финишировало: ${c.finished}</p>
      <div>${action}</div></div>
    <section class="section"><h2>Результаты</h2>${rows}</section>`;
  const btn = document.getElementById("start-comp");
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    try { startGame(await api(`/competitions/${id}/start`, { body: {} })); }
    catch (e) { toast(e.message, true); btn.disabled = false; }
  };
}

async function pagePlay() {
  if (!state.user) return needLogin("Войдите в аккаунт, чтобы ваши результаты попадали в общий рейтинг.");
  const { play } = await api("/active");
  const resume = play ? `<div class="card resume-card">
      <div><b>У вас есть незаконченная игра</b><div class="muted small">Уровень: ${DIFFS[play.difficulty].title}</div></div>
      <button class="btn brown" id="resume">Продолжить</button></div>` : "";
  app.innerHTML = `<h1>Выберите уровень</h1>${resume}
    <div class="grid cols-4">${Object.entries(DIFFS).map(([k, d]) => `<div class="card diff-card" data-d="${k}">
      <h3>${d.title}</h3><p class="muted small" style="margin:0">${d.desc}</p></div>`).join("")}</div>
    <p class="muted small" style="margin-top:18px">Новая игра заменит незаконченную. Время считает сервер, поэтому перезагрузка страницы таймер не сбрасывает.</p>`;
  if (play) document.getElementById("resume").onclick = () => startGame(play);
  document.querySelectorAll(".diff-card").forEach(el => el.onclick = async () => {
    try { startGame(await api("/puzzle/new", { body: { difficulty: el.dataset.d } })); }
    catch (e) { toast(e.message, true); }
  });
}

const PEERS = (() => {
  const res = [];
  for (let i = 0; i < 81; i++) {
    const r = Math.floor(i / 9), c = i % 9, set = new Set();
    for (let k = 0; k < 9; k++) { set.add(r * 9 + k); set.add(k * 9 + c); }
    const br = r - r % 3, bc = c - c % 3;
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) set.add((br + a) * 9 + bc + b);
    set.delete(i);
    res.push(set);
  }
  return res;
})();

function startGame(play) {
  stopGameHooks();
  const given = [...play.puzzle].map(Number);
  const key = "sudoku_progress_" + play.play_id;
  const g = {
    values: given.slice(), notes: Array(81).fill(0), hinted: new Set(),
    sel: -1, noteMode: false, mistakes: 0, hints: play.hints || 0, undo: [], done: false, busy: false,
  };
  try {
    const s = JSON.parse(localStorage.getItem(key));
    if (s && s.values && s.values.length === 81 && given.every((v, i) => !v || s.values[i] === v)) {
      g.values = s.values; g.notes = s.notes || g.notes; g.mistakes = s.mistakes || 0;
      g.hinted = new Set(s.hinted || []); g.hints = Math.max(g.hints, s.hints || 0);
    }
  } catch (e) {}
  const save = () => {
    try { localStorage.setItem(key, JSON.stringify({ values: g.values, notes: g.notes, mistakes: g.mistakes, hints: g.hints, hinted: [...g.hinted] })); } catch (e) {}
  };

  const title = play.competition_title ? `${esc(play.competition_title)}` : `${DIFFS[play.difficulty].title}`;
  app.innerHTML = `<section>
    <div class="section-head" style="margin-bottom:10px"><h2 style="margin:0">${title}</h2>
      <a href="${play.competition_id ? "#/competition/" + play.competition_id : "#/play"}" class="small">← Выйти (игра сохранится)</a></div>
    <div class="game-top">
      <div class="gstat"><span>Время</span><b id="g-time">00:00</b></div>
      <div class="gstat"><span>Ошибки</span><b id="g-err">0</b></div>
      <div class="gstat"><span>Подсказки</span><b id="g-hints">0/${MAX_HINTS}</b></div>
    </div>
    <div class="game-main">
      <div id="board" class="board"></div>
      <div class="side">
        <div class="tools">
          <button class="btn ghost" id="t-undo">Отменить</button>
          <button class="btn ghost" id="t-erase">Стереть</button>
          <button class="btn ghost" id="t-notes">Заметки: выкл</button>
          <button class="btn ghost" id="t-hint">Подсказка</button>
        </div>
        <div class="numpad" id="numpad"></div>
        <p class="muted small" style="margin:0">Клавиатура: цифры 1–9, Backspace — стереть, стрелки — перемещение, N — заметки, Z — отменить. Подсказка раскрывает выбранную клетку (−25 очков), ошибка — −15 очков.</p>
      </div>
    </div></section>`;

  const boardEl = document.getElementById("board");
  const cells = [];
  for (let i = 0; i < 81; i++) {
    const c = document.createElement("div");
    c.className = "cell";
    c.dataset.i = i;
    boardEl.appendChild(c);
    cells.push(c);
  }
  boardEl.addEventListener("click", e => {
    const c = e.target.closest(".cell");
    if (c) { g.sel = +c.dataset.i; paint(); }
  });
  const pad = document.getElementById("numpad");
  for (let d = 1; d <= 9; d++) {
    const b = document.createElement("button");
    b.dataset.d = d;
    b.innerHTML = `${d}<small></small>`;
    b.onclick = () => setDigit(d);
    pad.appendChild(b);
  }

  function hasConflict(i) {
    const v = g.values[i];
    if (!v) return false;
    for (const p of PEERS[i]) if (g.values[p] === v) return true;
    return false;
  }

  function paint() {
    const selV = g.sel >= 0 ? g.values[g.sel] : 0;
    const counts = Array(10).fill(0);
    for (let i = 0; i < 81; i++) {
      const v = g.values[i];
      if (v) counts[v]++;
      const c = cells[i];
      let cls = "cell";
      if (i % 9 === 2 || i % 9 === 5) cls += " r3";
      if (Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5) cls += " b3";
      if (given[i]) cls += " given";
      if (g.hinted.has(i)) cls += " hinted";
      if (g.sel >= 0 && i !== g.sel && PEERS[g.sel].has(i)) cls += " peer";
      if (selV && v === selV && i !== g.sel) cls += " same";
      if (i === g.sel) cls += " sel";
      if (!given[i] && hasConflict(i)) cls += " bad";
      c.className = cls;
      if (v) c.textContent = v;
      else if (g.notes[i]) {
        let h = '<div class="notes">';
        for (let d = 1; d <= 9; d++) h += `<i>${g.notes[i] & (1 << d) ? d : ""}</i>`;
        c.innerHTML = h + "</div>";
      } else c.textContent = "";
    }
    pad.querySelectorAll("button").forEach(b => {
      const d = +b.dataset.d, left = 9 - counts[d];
      b.disabled = left <= 0;
      b.querySelector("small").textContent = left > 0 ? left : "";
    });
    document.getElementById("g-err").textContent = g.mistakes;
    document.getElementById("g-hints").textContent = `${g.hints}/${MAX_HINTS}`;
    document.getElementById("t-notes").textContent = "Заметки: " + (g.noteMode ? "вкл" : "выкл");
    document.getElementById("t-notes").classList.toggle("on", g.noteMode);
  }

  function pushUndo() {
    g.undo.push({ values: g.values.slice(), notes: g.notes.slice(), hinted: new Set(g.hinted) });
    if (g.undo.length > 100) g.undo.shift();
  }
  function clearPeerNotes(i, d) {
    for (const p of PEERS[i]) g.notes[p] &= ~(1 << d);
  }

  function setDigit(d) {
    if (g.done || g.busy || g.sel < 0 || given[g.sel] || g.hinted.has(g.sel)) return;
    const i = g.sel;
    if (g.noteMode) {
      if (g.values[i]) return;
      pushUndo();
      g.notes[i] ^= (1 << d);
    } else {
      pushUndo();
      if (g.values[i] === d) { g.values[i] = 0; }
      else {
        g.values[i] = d; g.notes[i] = 0;
        clearPeerNotes(i, d);
        if (hasConflict(i)) g.mistakes++;
      }
    }
    save(); paint(); checkDone();
  }
  function erase() {
    if (g.done || g.busy || g.sel < 0 || given[g.sel] || g.hinted.has(g.sel)) return;
    if (!g.values[g.sel] && !g.notes[g.sel]) return;
    pushUndo();
    g.values[g.sel] = 0; g.notes[g.sel] = 0;
    save(); paint();
  }
  function undo() {
    if (g.done || g.busy || !g.undo.length) return;
    const s = g.undo.pop();
    g.values = s.values; g.notes = s.notes; g.hinted = s.hinted;
    save(); paint();
  }
  async function hint() {
    if (g.done || g.busy) return;
    if (g.hints >= MAX_HINTS) return toast("Подсказки закончились", true);
    if (g.sel < 0 || given[g.sel] || g.hinted.has(g.sel)) return toast("Выберите пустую клетку или клетку с вашей цифрой");
    g.busy = true;
    try {
      const r = await api("/hint", { body: { play_id: play.play_id, cell: g.sel } });
      pushUndo();
      const i = g.sel;
      g.values[i] = r.value; g.notes[i] = 0; g.hinted.add(i);
      clearPeerNotes(i, r.value);
      g.hints = r.hints;
      save(); paint();
    } catch (e) { toast(e.message, true); }
    g.busy = false;
    checkDone();
  }

  document.getElementById("t-undo").onclick = undo;
  document.getElementById("t-erase").onclick = erase;
  document.getElementById("t-hint").onclick = hint;
  document.getElementById("t-notes").onclick = () => { g.noteMode = !g.noteMode; paint(); };

  state.keyHandler = e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[1-9]$/.test(e.key)) { setDigit(+e.key); e.preventDefault(); }
    else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") { erase(); e.preventDefault(); }
    else if (e.key.toLowerCase() === "n" || e.key.toLowerCase() === "т") { g.noteMode = !g.noteMode; paint(); }
    else if (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "я") undo();
    else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      if (g.sel < 0) g.sel = 40;
      else {
        let r = Math.floor(g.sel / 9), c = g.sel % 9;
        if (e.key === "ArrowUp") r = Math.max(0, r - 1);
        if (e.key === "ArrowDown") r = Math.min(8, r + 1);
        if (e.key === "ArrowLeft") c = Math.max(0, c - 1);
        if (e.key === "ArrowRight") c = Math.min(8, c + 1);
        g.sel = r * 9 + c;
      }
      paint();
    }
  };
  document.addEventListener("keydown", state.keyHandler);

  const tick = () => { document.getElementById("g-time").textContent = fmtTime(nowServer() - play.started_at); };
  tick();
  state.timer = setInterval(tick, 500);

  async function checkDone() {
    if (g.done || g.busy) return;
    if (g.values.some(v => !v)) return;
    for (let i = 0; i < 81; i++) if (hasConflict(i)) return;
    g.done = true;
    clearInterval(state.timer);
    try {
      const r = await api("/finish", { body: { play_id: play.play_id, board: g.values.join(""), mistakes: g.mistakes } });
      try { localStorage.removeItem(key); } catch (e) {}
      showResult(r, play);
    } catch (e) {
      g.done = false;
      state.timer = setInterval(tick, 500);
      toast(e.message, true);
    }
  }

  paint();
  checkDone();
}

function showResult(r, play) {
  const comp = play.competition_id;
  const ov = modal(`
    <h2>Судоку решено!</h2>
    <div class="score">${r.score}</div><div class="muted">очков</div>
    <div class="facts">
      <div><b>${fmtTime(r.seconds)}</b><span>время</span></div>
      <div><b>${r.mistakes}</b><span>ошибок</span></div>
      <div><b>${r.hints}</b><span>подсказок</span></div>
    </div>
    ${r.record ? `<p><b>Новый личный рекорд на этом уровне!</b></p>` : ""}
    ${comp ? `<p>Ваше место в соревновании: <b>${r.rank}</b></p>` : ""}
    <div class="row">
      ${comp ? `<a class="btn" id="r-main" href="#/competition/${comp}">К результатам</a>`
             : `<a class="btn" id="r-main" href="#/play">Играть ещё</a>`}
      <a class="btn ghost" id="r-lb" href="#/leaderboard">Рейтинг</a>
    </div>`);
  ov.querySelectorAll("a").forEach(a => a.addEventListener("click", () => ov.close()));
}

window.addEventListener("hashchange", router);
loadMe().then(router);