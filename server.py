import hashlib
import json
import os
import random
import re
import secrets
import sqlite3
import time
import traceback
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("SUDOKU_DB", os.path.join(BASE_DIR, "sudoku.db"))
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
}

SESSION_TTL = 30 * 24 * 3600
MAX_HINTS = 3

DIFF = {
    "easy":   {"title": "Лёгкий",  "clues": 40, "base": 100, "par": 600},
    "medium": {"title": "Средний", "clues": 32, "base": 200, "par": 900},
    "hard":   {"title": "Сложный", "clues": 27, "base": 350, "par": 1200},
    "expert": {"title": "Эксперт", "clues": 24, "base": 500, "par": 1800},
}

POP = [bin(i).count("1") for i in range(1024)]


def solve(grid, limit, rng=None):
    rows, cols, boxes = [0] * 9, [0] * 9, [0] * 9
    g = list(grid)
    for i, v in enumerate(g):
        if v:
            b = 1 << v
            r, c = divmod(i, 9)
            rows[r] |= b
            cols[c] |= b
            boxes[(r // 3) * 3 + c // 3] |= b
    state = {"count": 0, "sol": None}

    def rec():
        best, bestmask, bestn = -1, 0, 10
        for i in range(81):
            if g[i] == 0:
                r, c = divmod(i, 9)
                m = ~(rows[r] | cols[c] | boxes[(r // 3) * 3 + c // 3]) & 0x3FE
                n = POP[m]
                if n < bestn:
                    best, bestmask, bestn = i, m, n
                    if n <= 1:
                        break
        if best < 0:
            state["count"] += 1
            if state["sol"] is None:
                state["sol"] = g[:]
            return state["count"] >= limit
        if bestn == 0:
            return False
        r, c = divmod(best, 9)
        bi = (r // 3) * 3 + c // 3
        digits = [d for d in range(1, 10) if (bestmask >> d) & 1]
        if rng:
            rng.shuffle(digits)
        for d in digits:
            b = 1 << d
            g[best] = d
            rows[r] |= b
            cols[c] |= b
            boxes[bi] |= b
            if rec():
                return True
            g[best] = 0
            rows[r] &= ~b
            cols[c] &= ~b
            boxes[bi] &= ~b
        return False

    rec()
    return state["count"], state["sol"]


def generate(difficulty, rng):
    _, sol = solve([0] * 81, 1, rng)
    puzzle = sol[:]
    cells = list(range(81))
    rng.shuffle(cells)
    clues = 81
    target = DIFF[difficulty]["clues"]
    for i in cells:
        if clues <= target:
            break
        keep = puzzle[i]
        puzzle[i] = 0
        cnt, _ = solve(puzzle, 2)
        if cnt != 1:
            puzzle[i] = keep
        else:
            clues -= 1
    return "".join(map(str, puzzle)), "".join(map(str, sol))


def new_puzzle(difficulty):
    return generate(difficulty, random.Random(secrets.randbits(64)))


def calc_score(difficulty, seconds, mistakes, hints):
    d = DIFF[difficulty]
    bonus = max(0.0, (d["par"] - seconds) / d["par"]) * d["base"]
    score = d["base"] + bonus - mistakes * 15 - hints * 25
    return max(10, int(round(score)))


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    salt TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS competitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    puzzle TEXT NOT NULL,
    solution TEXT NOT NULL,
    created_by INTEGER
);
CREATE TABLE IF NOT EXISTS plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    difficulty TEXT NOT NULL,
    puzzle TEXT NOT NULL,
    solution TEXT NOT NULL,
    competition_id INTEGER REFERENCES competitions(id),
    started_at REAL NOT NULL,
    finished_at REAL,
    seconds REAL,
    mistakes INTEGER NOT NULL DEFAULT 0,
    hints INTEGER NOT NULL DEFAULT 0,
    score INTEGER,
    status TEXT NOT NULL DEFAULT 'active'
);
CREATE UNIQUE INDEX IF NOT EXISTS one_try_per_competition
    ON plays(user_id, competition_id) WHERE competition_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS plays_status ON plays(status, difficulty);
"""


def db():
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


def create_competition(con, title, description, difficulty, start_at, end_at, created_by=None):
    puzzle, solution = new_puzzle(difficulty)
    cur = con.execute(
        "INSERT INTO competitions(title, description, difficulty, start_at, end_at, puzzle, solution, created_by)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (title, description, difficulty, start_at, end_at, puzzle, solution, created_by),
    )
    return cur.lastrowid


def init_db():
    con = db()
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    if con.execute("SELECT COUNT(*) FROM competitions").fetchone()[0] == 0:
        now = int(time.time())
        create_competition(
            con, "Лесной кубок",
            "Открытый турнир для всех: один пазл и одна попытка. Побеждает тот, кто набрал больше очков.",
            "medium", now - 3600, now + 7 * 86400)
        create_competition(
            con, "Осенний марафон",
            "Сложный пазл для опытных охотников за цифрами.",
            "hard", now + 2 * 86400, now + 9 * 86400)
    con.commit()
    con.close()


def hash_pw(password, salt_hex):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), 120_000).hex()


USERNAME_RE = re.compile(r"^[A-Za-zА-Яа-яЁё0-9_]{3,20}$")


class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status
        self.msg = msg


def comp_status(c, now):
    if now < c["start_at"]:
        return "upcoming"
    if now <= c["end_at"]:
        return "active"
    return "finished"


def public_user(u):
    return {"id": u["id"], "username": u["username"], "is_admin": bool(u["is_admin"])}


def play_payload(p, extra=None):
    out = {
        "play_id": p["id"],
        "difficulty": p["difficulty"],
        "puzzle": p["puzzle"],
        "started_at": p["started_at"],
        "hints": p["hints"],
        "competition_id": p["competition_id"],
    }
    if extra:
        out.update(extra)
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "SudokuForest/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, status, body, ctype, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, obj, headers=None):
        if isinstance(obj, dict):
            obj.setdefault("server_time", time.time())
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", headers)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 20000:
            raise ApiError(413, "Слишком большой запрос")
        raw = self.rfile.read(n) if n else b""
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            raise ApiError(400, "Некорректный JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "Некорректный запрос")
        return data

    def _user(self, con):
        jar = SimpleCookie(self.headers.get("Cookie", ""))
        m = jar.get("sid")
        if not m:
            return None
        return con.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token=? AND s.created_at>?",
            (m.value, int(time.time()) - SESSION_TTL),
        ).fetchone()

    def _login_cookie(self, con, user_id):
        token = secrets.token_hex(32)
        con.execute("INSERT INTO sessions(token, user_id, created_at) VALUES (?,?,?)",
                    (token, user_id, int(time.time())))
        con.commit()
        return [("Set-Cookie", f"sid={token}; HttpOnly; Path=/; SameSite=Lax; Max-Age={SESSION_TTL}")]

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def _route(self, method):
        url = urlparse(self.path)
        path = url.path
        try:
            if method == "GET" and path in STATIC_FILES:
                name, ctype = STATIC_FILES[path]
                with open(os.path.join(BASE_DIR, name), "rb") as f:
                    self._send(200, f.read(), ctype)
            elif path.startswith("/api/"):
                con = db()
                try:
                    self._api(con, method, path[4:], parse_qs(url.query))
                finally:
                    con.close()
            else:
                self._send(404, "Страница не найдена".encode("utf-8"), "text/plain; charset=utf-8")
        except ApiError as e:
            self._json(e.status, {"error": e.msg})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                self._json(500, {"error": "Внутренняя ошибка сервера"})
            except Exception:
                pass

    def _api(self, con, method, path, q):
        user = self._user(con)
        now = time.time()

        def need_user():
            if not user:
                raise ApiError(401, "Нужно войти в аккаунт")
            return user

        def first(name, default=None):
            return q.get(name, [default])[0]

        if method == "GET" and path == "/me":
            return self._json(200, {"user": public_user(user) if user else None})

        if method == "POST" and path == "/register":
            d = self._body()
            name = str(d.get("username", "")).strip()
            pw = str(d.get("password", ""))
            if not USERNAME_RE.match(name):
                raise ApiError(400, "Имя: 3–20 символов, только буквы, цифры и _")
            if len(pw) < 6 or len(pw) > 100:
                raise ApiError(400, "Пароль должен быть не короче 6 символов")
            salt = secrets.token_hex(16)
            is_admin = 1 if con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0 else 0
            try:
                cur = con.execute(
                    "INSERT INTO users(username, salt, pass_hash, is_admin, created_at) VALUES (?,?,?,?,?)",
                    (name, salt, hash_pw(pw, salt), is_admin, int(now)))
            except sqlite3.IntegrityError:
                raise ApiError(409, "Такое имя уже занято")
            con.commit()
            hdr = self._login_cookie(con, cur.lastrowid)
            u = con.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
            return self._json(200, {"user": public_user(u)}, hdr)

        if method == "POST" and path == "/login":
            d = self._body()
            name = str(d.get("username", "")).strip()
            pw = str(d.get("password", ""))
            u = con.execute("SELECT * FROM users WHERE username=?", (name,)).fetchone()
            if not u or not secrets.compare_digest(hash_pw(pw, u["salt"]), u["pass_hash"]):
                raise ApiError(401, "Неверное имя или пароль")
            hdr = self._login_cookie(con, u["id"])
            return self._json(200, {"user": public_user(u)}, hdr)

        if method == "POST" and path == "/logout":
            jar = SimpleCookie(self.headers.get("Cookie", ""))
            if jar.get("sid"):
                con.execute("DELETE FROM sessions WHERE token=?", (jar["sid"].value,))
                con.commit()
            return self._json(200, {"ok": True},
                              [("Set-Cookie", "sid=; HttpOnly; Path=/; Max-Age=0")])

        if method == "GET" and path == "/stats":
            players = con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            games = con.execute("SELECT COUNT(*) FROM plays WHERE status='done'").fetchone()[0]
            act = con.execute("SELECT COUNT(*) FROM competitions WHERE start_at<=? AND end_at>=?",
                              (now, now)).fetchone()[0]
            return self._json(200, {"players": players, "games": games, "active_competitions": act})

        if method == "POST" and path == "/puzzle/new":
            need_user()
            diff = str(self._body().get("difficulty", ""))
            if diff not in DIFF:
                raise ApiError(400, "Неизвестный уровень сложности")
            puzzle, solution = new_puzzle(diff)
            con.execute("UPDATE plays SET status='abandoned' "
                        "WHERE user_id=? AND competition_id IS NULL AND status='active'", (user["id"],))
            cur = con.execute(
                "INSERT INTO plays(user_id, difficulty, puzzle, solution, started_at) VALUES (?,?,?,?,?)",
                (user["id"], diff, puzzle, solution, now))
            con.commit()
            p = con.execute("SELECT * FROM plays WHERE id=?", (cur.lastrowid,)).fetchone()
            return self._json(200, play_payload(p))

        if method == "GET" and path == "/active":
            need_user()
            p = con.execute(
                "SELECT * FROM plays WHERE user_id=? AND competition_id IS NULL AND status='active' "
                "AND started_at>? ORDER BY id DESC LIMIT 1", (user["id"], now - 86400)).fetchone()
            return self._json(200, {"play": play_payload(p) if p else None})

        if method == "POST" and path == "/hint":
            need_user()
            d = self._body()
            p = self._own_active_play(con, user, d.get("play_id"))
            try:
                cell = int(d.get("cell"))
            except (TypeError, ValueError):
                raise ApiError(400, "Не указана клетка")
            if not 0 <= cell <= 80:
                raise ApiError(400, "Неверная клетка")
            if p["hints"] >= MAX_HINTS:
                raise ApiError(400, f"Лимит подсказок ({MAX_HINTS}) исчерпан")
            con.execute("UPDATE plays SET hints=hints+1 WHERE id=?", (p["id"],))
            con.commit()
            return self._json(200, {"value": int(p["solution"][cell]), "hints": p["hints"] + 1})

        if method == "POST" and path == "/finish":
            need_user()
            d = self._body()
            p = self._own_active_play(con, user, d.get("play_id"))
            board = str(d.get("board", ""))
            if board != p["solution"]:
                wrong = sum(1 for a, b in zip(board, p["solution"]) if a != b) if len(board) == 81 else 81
                raise ApiError(400, f"В решении есть ошибки (неверных клеток: {wrong})")
            if p["competition_id"]:
                c = con.execute("SELECT * FROM competitions WHERE id=?", (p["competition_id"],)).fetchone()
                if c and now > c["end_at"]:
                    raise ApiError(400, "Соревнование уже завершилось")
            try:
                mistakes = max(0, min(99, int(d.get("mistakes", 0))))
            except (TypeError, ValueError):
                mistakes = 0
            seconds = max(1.0, now - p["started_at"])
            score = calc_score(p["difficulty"], seconds, mistakes, p["hints"])
            prev_best = con.execute(
                "SELECT MIN(seconds) FROM plays WHERE user_id=? AND difficulty=? AND status='done'",
                (user["id"], p["difficulty"])).fetchone()[0]
            con.execute(
                "UPDATE plays SET status='done', finished_at=?, seconds=?, mistakes=?, score=? WHERE id=?",
                (now, seconds, mistakes, score, p["id"]))
            con.commit()
            out = {"score": score, "seconds": seconds, "mistakes": mistakes, "hints": p["hints"],
                   "record": prev_best is None or seconds < prev_best}
            if p["competition_id"]:
                out["rank"] = con.execute(
                    "SELECT COUNT(*) FROM plays WHERE competition_id=? AND status='done' "
                    "AND (score>? OR (score=? AND seconds<?))",
                    (p["competition_id"], score, score, seconds)).fetchone()[0] + 1
            return self._json(200, out)

        if method == "GET" and path == "/competitions":
            rows = con.execute(
                "SELECT c.*, (SELECT COUNT(*) FROM plays p WHERE p.competition_id=c.id) AS participants, "
                "(SELECT COUNT(*) FROM plays p WHERE p.competition_id=c.id AND p.status='done') AS finished "
                "FROM competitions c ORDER BY c.start_at DESC").fetchall()
            return self._json(200, {"competitions": [self._comp_json(c, now) for c in rows]})

        if method == "POST" and path == "/competitions":
            need_user()
            if not user["is_admin"]:
                raise ApiError(403, "Создавать соревнования может только администратор")
            d = self._body()
            title = str(d.get("title", "")).strip()
            desc = str(d.get("description", "")).strip()
            diff = str(d.get("difficulty", ""))
            try:
                start_at, end_at = int(d.get("start_at")), int(d.get("end_at"))
            except (TypeError, ValueError):
                raise ApiError(400, "Укажите даты начала и окончания")
            if not 3 <= len(title) <= 60:
                raise ApiError(400, "Название: от 3 до 60 символов")
            if len(desc) > 300:
                raise ApiError(400, "Описание не длиннее 300 символов")
            if diff not in DIFF:
                raise ApiError(400, "Неизвестный уровень сложности")
            if end_at <= start_at or end_at - start_at > 60 * 86400:
                raise ApiError(400, "Окончание должно быть позже начала (не больше 60 дней)")
            cid = create_competition(con, title, desc, diff, start_at, end_at, user["id"])
            con.commit()
            return self._json(200, {"id": cid})

        m = re.match(r"^/competitions/(\d+)$", path)
        if method == "GET" and m:
            c = self._get_comp(con, int(m.group(1)))
            rows = con.execute(
                "SELECT u.username, p.score, p.seconds, p.mistakes, p.hints FROM plays p "
                "JOIN users u ON u.id=p.user_id WHERE p.competition_id=? AND p.status='done' "
                "ORDER BY p.score DESC, p.seconds ASC", (c["id"],)).fetchall()
            results = [{"rank": i + 1, **dict(r)} for i, r in enumerate(rows)]
            participants = con.execute("SELECT COUNT(*) FROM plays WHERE competition_id=?", (c["id"],)).fetchone()[0]
            my = None
            if user:
                p = con.execute("SELECT id, status FROM plays WHERE competition_id=? AND user_id=?",
                                (c["id"], user["id"])).fetchone()
                if p:
                    my = {"play_id": p["id"], "status": p["status"]}
            cj = self._comp_json(c, now)
            cj["participants"] = participants
            cj["finished"] = len(results)
            return self._json(200, {"competition": cj, "results": results, "my": my})

        m = re.match(r"^/competitions/(\d+)/start$", path)
        if method == "POST" and m:
            need_user()
            c = self._get_comp(con, int(m.group(1)))
            st = comp_status(c, now)
            if st != "active":
                raise ApiError(400, "Соревнование ещё не началось" if st == "upcoming" else "Соревнование уже завершилось")
            p = con.execute("SELECT * FROM plays WHERE competition_id=? AND user_id=?",
                            (c["id"], user["id"])).fetchone()
            if p and p["status"] == "done":
                raise ApiError(409, "Вы уже участвовали в этом соревновании")
            if not p:
                try:
                    cur = con.execute(
                        "INSERT INTO plays(user_id, difficulty, puzzle, solution, competition_id, started_at) "
                        "VALUES (?,?,?,?,?,?)",
                        (user["id"], c["difficulty"], c["puzzle"], c["solution"], c["id"], now))
                    con.commit()
                except sqlite3.IntegrityError:
                    raise ApiError(409, "Вы уже участвуете в этом соревновании")
                p = con.execute("SELECT * FROM plays WHERE id=?", (cur.lastrowid,)).fetchone()
            return self._json(200, play_payload(p, {"competition_title": c["title"], "end_at": c["end_at"]}))

        if method == "GET" and path == "/leaderboard":
            kind = first("type", "points")
            period = first("period", "all")
            diff = first("difficulty", "easy")
            since = now - 7 * 86400 if period == "week" else 0
            if kind == "best":
                if diff not in DIFF:
                    raise ApiError(400, "Неизвестный уровень сложности")
                rows = con.execute(
                    "SELECT u.username, MIN(p.seconds) AS best, COUNT(p.id) AS games FROM plays p "
                    "JOIN users u ON u.id=p.user_id WHERE p.status='done' AND p.difficulty=? AND p.finished_at>=? "
                    "GROUP BY u.id ORDER BY best ASC LIMIT 100", (diff, since)).fetchall()
            else:
                rows = con.execute(
                    "SELECT u.username, SUM(p.score) AS points, COUNT(p.id) AS games FROM plays p "
                    "JOIN users u ON u.id=p.user_id WHERE p.status='done' AND p.finished_at>=? "
                    "GROUP BY u.id ORDER BY points DESC, games ASC LIMIT 100", (since,)).fetchall()
            return self._json(200, {"rows": [{"rank": i + 1, **dict(r)} for i, r in enumerate(rows)]})

        if method == "GET" and path == "/profile":
            name = first("username") or (user["username"] if user else None)
            if not name:
                raise ApiError(401, "Нужно войти в аккаунт")
            u = con.execute("SELECT * FROM users WHERE username=?", (name,)).fetchone()
            if not u:
                raise ApiError(404, "Игрок не найден")
            tot = con.execute(
                "SELECT COUNT(*) AS games, COALESCE(SUM(score),0) AS points FROM plays "
                "WHERE user_id=? AND status='done'", (u["id"],)).fetchone()
            comps = con.execute(
                "SELECT COUNT(*) FROM plays WHERE user_id=? AND status='done' AND competition_id IS NOT NULL",
                (u["id"],)).fetchone()[0]
            best = {r["difficulty"]: r["b"] for r in con.execute(
                "SELECT difficulty, MIN(seconds) AS b FROM plays WHERE user_id=? AND status='done' "
                "GROUP BY difficulty", (u["id"],))}
            hist = con.execute(
                "SELECT p.difficulty, p.seconds, p.mistakes, p.hints, p.score, p.finished_at, c.title AS competition "
                "FROM plays p LEFT JOIN competitions c ON c.id=p.competition_id "
                "WHERE p.user_id=? AND p.status='done' ORDER BY p.finished_at DESC LIMIT 20",
                (u["id"],)).fetchall()
            return self._json(200, {
                "username": u["username"], "created_at": u["created_at"], "is_admin": bool(u["is_admin"]),
                "games": tot["games"], "points": tot["points"], "competitions": comps,
                "best": best, "history": [dict(h) for h in hist]})

        raise ApiError(404, "Такого запроса нет")

    def _own_active_play(self, con, user, play_id):
        try:
            pid = int(play_id)
        except (TypeError, ValueError):
            raise ApiError(400, "Не указана игра")
        p = con.execute("SELECT * FROM plays WHERE id=? AND user_id=?", (pid, user["id"])).fetchone()
        if not p:
            raise ApiError(404, "Игра не найдена")
        if p["status"] != "active":
            raise ApiError(400, "Эта игра уже завершена")
        return p

    def _get_comp(self, con, cid):
        c = con.execute("SELECT * FROM competitions WHERE id=?", (cid,)).fetchone()
        if not c:
            raise ApiError(404, "Соревнование не найдено")
        return c

    def _comp_json(self, c, now):
        out = {k: c[k] for k in ("id", "title", "description", "difficulty", "start_at", "end_at")}
        out["status"] = comp_status(c, now)
        for k in ("participants", "finished"):
            if k in c.keys():
                out[k] = c[k]
        return out


def main():
    init_db()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Судоку-Лес запущен: http://localhost:{PORT}")
    print("Остановить сервер: Ctrl+C")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен")


if __name__ == "__main__":
    main()