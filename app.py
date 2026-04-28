import sqlite3
import os
from flask import Flask, jsonify, request, g, render_template

app = Flask(__name__)
DATABASE = os.path.join(os.path.dirname(__file__), "pomodoro.db")


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_db():
    db = getattr(g, "_database", None)
    if db is None:
        db = g._database = sqlite3.connect(DATABASE)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA foreign_keys=ON")
    return db


@app.teardown_appcontext
def close_connection(exception):
    db = getattr(g, "_database", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DATABASE)
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS goals (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            title     TEXT    NOT NULL,
            category  TEXT    NOT NULL DEFAULT 'other',
            note      TEXT    NOT NULL DEFAULT '',
            done      INTEGER NOT NULL DEFAULT 0,
            created   TEXT    NOT NULL DEFAULT (date('now'))
        );

        CREATE TABLE IF NOT EXISTS subgoals (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            goal_id   INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
            title     TEXT    NOT NULL,
            status    TEXT    NOT NULL DEFAULT 'pending',
            created   TEXT    NOT NULL DEFAULT (date('now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            goal_id   INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
            mins      INTEGER NOT NULL,
            date      TEXT    NOT NULL DEFAULT (date('now')),
            ts        TEXT    NOT NULL DEFAULT (time('now'))
        );
    """)
    db.commit()
    db.close()


# ---------------------------------------------------------------------------
# Routes – UI
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Routes – Goals
# ---------------------------------------------------------------------------

@app.route("/api/goals", methods=["GET"])
def get_goals():
    db = get_db()
    goals = db.execute(
        "SELECT * FROM goals ORDER BY created DESC, id DESC"
    ).fetchall()

    result = []
    for g_row in goals:
        goal = dict(g_row)
        goal["done"] = bool(goal["done"])
        subgoals = db.execute(
            "SELECT * FROM subgoals WHERE goal_id=? ORDER BY created, id",
            (goal["id"],)
        ).fetchall()
        goal["subgoals"] = [dict(s) for s in subgoals]
        sessions = db.execute(
            "SELECT COUNT(*) as pomos, SUM(mins) as total_mins FROM sessions WHERE goal_id=?",
            (goal["id"],)
        ).fetchone()
        goal["pomos"] = sessions["pomos"] or 0
        goal["total_mins"] = sessions["total_mins"] or 0
        result.append(goal)

    return jsonify(result)


@app.route("/api/goals", methods=["POST"])
def create_goal():
    data = request.get_json()
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO goals (title, category, note) VALUES (?, ?, ?)",
        (title, data.get("category", "other"), data.get("note", ""))
    )
    db.commit()
    goal = dict(db.execute("SELECT * FROM goals WHERE id=?", (cur.lastrowid,)).fetchone())
    goal["done"] = bool(goal["done"])
    goal["subgoals"] = []
    goal["pomos"] = 0
    goal["total_mins"] = 0
    return jsonify(goal), 201


@app.route("/api/goals/<int:goal_id>", methods=["PATCH"])
def update_goal(goal_id):
    data = request.get_json()
    db = get_db()
    row = db.execute("SELECT * FROM goals WHERE id=?", (goal_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    done = int(data["done"]) if "done" in data else row["done"]
    title = data.get("title", row["title"])
    note = data.get("note", row["note"])
    category = data.get("category", row["category"])
    db.execute(
        "UPDATE goals SET done=?, title=?, note=?, category=? WHERE id=?",
        (done, title, note, category, goal_id)
    )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/goals/<int:goal_id>", methods=["DELETE"])
def delete_goal(goal_id):
    db = get_db()
    db.execute("DELETE FROM goals WHERE id=?", (goal_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/categories", methods=["GET"])
def get_categories():
    """Return all distinct categories currently in use, sorted alphabetically."""
    db = get_db()
    rows = db.execute(
        "SELECT DISTINCT category FROM goals WHERE category != '' ORDER BY category"
    ).fetchall()
    return jsonify([r["category"] for r in rows])


# ---------------------------------------------------------------------------
# Routes – Subgoals
# ---------------------------------------------------------------------------

@app.route("/api/goals/<int:goal_id>/subgoals", methods=["POST"])
def create_subgoal(goal_id):
    data = request.get_json()
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400
    db = get_db()
    if not db.execute("SELECT id FROM goals WHERE id=?", (goal_id,)).fetchone():
        return jsonify({"error": "goal not found"}), 404
    cur = db.execute(
        "INSERT INTO subgoals (goal_id, title) VALUES (?, ?)", (goal_id, title)
    )
    db.commit()
    row = dict(db.execute("SELECT * FROM subgoals WHERE id=?", (cur.lastrowid,)).fetchone())
    return jsonify(row), 201


@app.route("/api/subgoals/<int:sub_id>", methods=["PATCH"])
def update_subgoal(sub_id):
    data = request.get_json()
    db = get_db()
    row = db.execute("SELECT * FROM subgoals WHERE id=?", (sub_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    status = data.get("status", row["status"])
    if status not in ("pending", "done", "failed"):
        return jsonify({"error": "invalid status"}), 400
    db.execute("UPDATE subgoals SET status=? WHERE id=?", (status, sub_id))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/subgoals/<int:sub_id>", methods=["DELETE"])
def delete_subgoal(sub_id):
    db = get_db()
    db.execute("DELETE FROM subgoals WHERE id=?", (sub_id,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes – Sessions
# ---------------------------------------------------------------------------

@app.route("/api/sessions", methods=["GET"])
def get_sessions():
    db = get_db()
    rows = db.execute(
        """
        SELECT s.*, g.title as goal_title
        FROM sessions s
        LEFT JOIN goals g ON g.id = s.goal_id
        ORDER BY s.date DESC, s.id DESC
        """
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/sessions", methods=["POST"])
def create_session():
    data = request.get_json()
    goal_id = data.get("goal_id")
    mins = data.get("mins", 25)
    if not goal_id:
        return jsonify({"error": "goal_id is required"}), 400
    db = get_db()
    if not db.execute("SELECT id FROM goals WHERE id=?", (goal_id,)).fetchone():
        return jsonify({"error": "goal not found"}), 404
    cur = db.execute(
        "INSERT INTO sessions (goal_id, mins) VALUES (?, ?)", (goal_id, mins)
    )
    db.commit()
    row = dict(db.execute("SELECT * FROM sessions WHERE id=?", (cur.lastrowid,)).fetchone())
    return jsonify(row), 201


@app.route("/api/stats", methods=["GET"])
def get_stats():
    db = get_db()
    total_pomos = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    total_mins = db.execute("SELECT COALESCE(SUM(mins),0) FROM sessions").fetchone()[0]
    today_pomos = db.execute(
        "SELECT COUNT(*) FROM sessions WHERE date=date('now')"
    ).fetchone()[0]
    done_subs = db.execute("SELECT COUNT(*) FROM subgoals WHERE status='done'").fetchone()[0]
    tracked_subs = db.execute("SELECT COUNT(*) FROM subgoals WHERE status!='pending'").fetchone()[0]
    by_goal = db.execute(
        """
        SELECT g.id, g.title, COUNT(s.id) as pomos, COALESCE(SUM(s.mins),0) as mins
        FROM goals g
        LEFT JOIN sessions s ON s.goal_id=g.id
        GROUP BY g.id ORDER BY mins DESC
        """
    ).fetchall()
    return jsonify({
        "total_pomos": total_pomos,
        "total_mins": total_mins,
        "today_pomos": today_pomos,
        "done_subs": done_subs,
        "tracked_subs": tracked_subs,
        "sub_pct": round((done_subs / tracked_subs * 100)) if tracked_subs else None,
        "by_goal": [dict(r) for r in by_goal],
    })


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    init_db()
    print("Starting Pomodoro Tracker at http://localhost:5000")
    app.run(debug=True, port=5000)