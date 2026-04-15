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
            category  TEXT    NOT NULL DEFAULT 'General',
            note      TEXT    NOT NULL DEFAULT '',
            done      INTEGER NOT NULL DEFAULT 0,
            created   TEXT    NOT NULL DEFAULT (date('now'))
        );

        CREATE TABLE IF NOT EXISTS subgoals (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            goal_id   INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
            title     TEXT    NOT NULL,
            note      TEXT    NOT NULL DEFAULT '',
            status    TEXT    NOT NULL DEFAULT 'pending',
            created   TEXT    NOT NULL DEFAULT (date('now')),
            updated   TEXT
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            goal_id   INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
            subgoal_id INTEGER REFERENCES subgoals(id) ON DELETE SET NULL,
            mins      INTEGER NOT NULL,
            date      TEXT    NOT NULL DEFAULT (date('now')),
            ts        TEXT    NOT NULL DEFAULT (time('now'))
        );
        
        -- Create indexes for better performance
        CREATE INDEX IF NOT EXISTS idx_sessions_goal ON sessions(goal_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_subgoal ON sessions(subgoal_id);
        CREATE INDEX IF NOT EXISTS idx_subgoals_goal ON subgoals(goal_id);
    """)
    
    # Check if we need to migrate existing database
    cursor = db.cursor()
    
    # Add note column to subgoals if it doesn't exist
    cursor.execute("PRAGMA table_info(subgoals)")
    columns = [col[1] for col in cursor.fetchall()]
    if 'note' not in columns:
        cursor.execute("ALTER TABLE subgoals ADD COLUMN note TEXT NOT NULL DEFAULT ''")
    
    # Add updated column to subgoals if it doesn't exist
    if 'updated' not in columns:
        cursor.execute("ALTER TABLE subgoals ADD COLUMN updated TEXT")
    
    # Add subgoal_id to sessions if it doesn't exist
    cursor.execute("PRAGMA table_info(sessions)")
    columns = [col[1] for col in cursor.fetchall()]
    if 'subgoal_id' not in columns:
        cursor.execute("ALTER TABLE sessions ADD COLUMN subgoal_id INTEGER REFERENCES subgoals(id) ON DELETE SET NULL")
    
    db.commit()
    db.close()


# ---------------------------------------------------------------------------
# Routes – UI
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Routes – Categories
# ---------------------------------------------------------------------------

@app.route("/api/categories", methods=["GET"])
def get_categories():
    """Get all unique categories for dropdown suggestions"""
    db = get_db()
    categories = db.execute(
        "SELECT DISTINCT category FROM goals WHERE category IS NOT NULL AND category != '' ORDER BY category"
    ).fetchall()
    return jsonify([cat["category"] for cat in categories])


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
        
        # Get subgoals with their notes
        subgoals = db.execute(
            "SELECT * FROM subgoals WHERE goal_id=? ORDER BY created, id",
            (goal["id"],)
        ).fetchall()
        goal["subgoals"] = [dict(s) for s in subgoals]
        
        # Get session stats
        sessions = db.execute(
            "SELECT COUNT(*) as pomos, SUM(mins) as total_mins FROM sessions WHERE goal_id=?",
            (goal["id"],)
        ).fetchone()
        goal["pomos"] = sessions["pomos"] or 0
        goal["total_mins"] = sessions["total_mins"] or 0
        
        # Calculate subgoal completion stats
        total_subs = len(subgoals)
        done_subs = sum(1 for s in subgoals if s["status"] == "done")
        failed_subs = sum(1 for s in subgoals if s["status"] == "failed")
        goal["subgoal_stats"] = {
            "total": total_subs,
            "done": done_subs,
            "failed": failed_subs,
            "pending": total_subs - done_subs - failed_subs
        }
        
        result.append(goal)

    return jsonify(result)


@app.route("/api/goals", methods=["POST"])
def create_goal():
    data = request.get_json()
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400
    
    category = (data.get("category") or "General").strip()
    note = (data.get("note") or "").strip()
    
    db = get_db()
    cur = db.execute(
        "INSERT INTO goals (title, category, note) VALUES (?, ?, ?)",
        (title, category, note)
    )
    db.commit()
    
    goal = dict(db.execute("SELECT * FROM goals WHERE id=?", (cur.lastrowid,)).fetchone())
    goal["done"] = bool(goal["done"])
    goal["subgoals"] = []
    goal["pomos"] = 0
    goal["total_mins"] = 0
    goal["subgoal_stats"] = {"total": 0, "done": 0, "failed": 0, "pending": 0}
    
    return jsonify(goal), 201


@app.route("/api/goals/<int:goal_id>", methods=["GET"])
def get_goal(goal_id):
    """Get a single goal with all its details"""
    db = get_db()
    goal = db.execute("SELECT * FROM goals WHERE id=?", (goal_id,)).fetchone()
    if not goal:
        return jsonify({"error": "not found"}), 404
    
    goal_dict = dict(goal)
    goal_dict["done"] = bool(goal_dict["done"])
    
    # Get subgoals
    subgoals = db.execute(
        "SELECT * FROM subgoals WHERE goal_id=? ORDER BY created, id",
        (goal_id,)
    ).fetchall()
    goal_dict["subgoals"] = [dict(s) for s in subgoals]
    
    # Get sessions
    sessions = db.execute(
        "SELECT COUNT(*) as pomos, SUM(mins) as total_mins FROM sessions WHERE goal_id=?",
        (goal_id,)
    ).fetchone()
    goal_dict["pomos"] = sessions["pomos"] or 0
    goal_dict["total_mins"] = sessions["total_mins"] or 0
    
    return jsonify(goal_dict)


@app.route("/api/goals/<int:goal_id>", methods=["PATCH"])
def update_goal(goal_id):
    data = request.get_json()
    db = get_db()
    row = db.execute("SELECT * FROM goals WHERE id=?", (goal_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    
    # Build update query dynamically based on provided fields
    updates = []
    values = []
    
    if "done" in data:
        updates.append("done = ?")
        values.append(int(data["done"]))
    if "title" in data:
        updates.append("title = ?")
        values.append(data["title"])
    if "note" in data:
        updates.append("note = ?")
        values.append(data["note"])
    if "category" in data:
        updates.append("category = ?")
        values.append(data["category"])
    
    if updates:
        values.append(goal_id)
        query = f"UPDATE goals SET {', '.join(updates)} WHERE id = ?"
        db.execute(query, values)
        db.commit()
    
    return jsonify({"ok": True})


@app.route("/api/goals/<int:goal_id>", methods=["DELETE"])
def delete_goal(goal_id):
    db = get_db()
    db.execute("DELETE FROM goals WHERE id=?", (goal_id,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes – Subgoals
# ---------------------------------------------------------------------------

@app.route("/api/goals/<int:goal_id>/subgoals", methods=["GET"])
def get_subgoals(goal_id):
    """Get all subgoals for a specific goal"""
    db = get_db()
    subgoals = db.execute(
        """
        SELECT s.*, 
               COUNT(se.id) as pomos, 
               COALESCE(SUM(se.mins), 0) as total_mins
        FROM subgoals s
        LEFT JOIN sessions se ON se.subgoal_id = s.id
        WHERE s.goal_id = ?
        GROUP BY s.id
        ORDER BY 
            CASE s.status 
                WHEN 'pending' THEN 1
                WHEN 'done' THEN 2
                WHEN 'failed' THEN 3
                ELSE 4
            END,
            s.created, s.id
        """,
        (goal_id,)
    ).fetchall()
    
    result = []
    for s in subgoals:
        subgoal = dict(s)
        # Add time tracking info
        subgoal["pomos"] = subgoal["pomos"] or 0
        subgoal["total_mins"] = subgoal["total_mins"] or 0
        result.append(subgoal)
    
    return jsonify(result)


@app.route("/api/goals/<int:goal_id>/subgoals", methods=["POST"])
def create_subgoal(goal_id):
    data = request.get_json()
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400
    
    note = (data.get("note") or "").strip()
    
    db = get_db()
    if not db.execute("SELECT id FROM goals WHERE id=?", (goal_id,)).fetchone():
        return jsonify({"error": "goal not found"}), 404
    
    cur = db.execute(
        "INSERT INTO subgoals (goal_id, title, note) VALUES (?, ?, ?)", 
        (goal_id, title, note)
    )
    db.commit()
    
    row = dict(db.execute("SELECT * FROM subgoals WHERE id=?", (cur.lastrowid,)).fetchone())
    row["pomos"] = 0
    row["total_mins"] = 0
    
    return jsonify(row), 201


@app.route("/api/subgoals/<int:sub_id>", methods=["GET"])
def get_subgoal(sub_id):
    """Get a single subgoal with its details"""
    db = get_db()
    subgoal = db.execute(
        """
        SELECT s.*, 
               COUNT(se.id) as pomos, 
               COALESCE(SUM(se.mins), 0) as total_mins
        FROM subgoals s
        LEFT JOIN sessions se ON se.subgoal_id = s.id
        WHERE s.id = ?
        GROUP BY s.id
        """,
        (sub_id,)
    ).fetchone()
    
    if not subgoal:
        return jsonify({"error": "not found"}), 404
    
    result = dict(subgoal)
    result["pomos"] = result["pomos"] or 0
    result["total_mins"] = result["total_mins"] or 0
    
    return jsonify(result)


@app.route("/api/subgoals/<int:sub_id>", methods=["PATCH"])
def update_subgoal(sub_id):
    data = request.get_json()
    db = get_db()
    row = db.execute("SELECT * FROM subgoals WHERE id=?", (sub_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    
    # Build update query dynamically
    updates = []
    values = []
    
    if "status" in data:
        status = data["status"]
        if status not in ("pending", "done", "failed"):
            return jsonify({"error": "invalid status"}), 400
        updates.append("status = ?")
        values.append(status)
    
    if "title" in data:
        updates.append("title = ?")
        values.append(data["title"])
    
    if "note" in data:
        updates.append("note = ?")
        values.append(data["note"])
    
    if updates:
        updates.append("updated = datetime('now')")
        values.append(sub_id)
        query = f"UPDATE subgoals SET {', '.join(updates)} WHERE id = ?"
        db.execute(query, values)
        db.commit()
    
    return jsonify({"ok": True})


@app.route("/api/subgoals/<int:sub_id>/note", methods=["PUT"])
def update_subgoal_note(sub_id):
    """Dedicated endpoint for updating just the note"""
    data = request.get_json()
    note = (data.get("note") or "").strip()
    
    db = get_db()
    row = db.execute("SELECT id FROM subgoals WHERE id=?", (sub_id,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    
    db.execute(
        "UPDATE subgoals SET note = ?, updated = datetime('now') WHERE id = ?",
        (note, sub_id)
    )
    db.commit()
    
    return jsonify({"ok": True, "note": note})


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
    
    # Get query parameters for filtering
    limit = request.args.get("limit", 50, type=int)
    goal_id = request.args.get("goal_id", type=int)
    subgoal_id = request.args.get("subgoal_id", type=int)
    
    query = """
        SELECT s.*, 
               g.title as goal_title,
               sg.title as subgoal_title
        FROM sessions s
        LEFT JOIN goals g ON g.id = s.goal_id
        LEFT JOIN subgoals sg ON sg.id = s.subgoal_id
        WHERE 1=1
    """
    params = []
    
    if goal_id:
        query += " AND s.goal_id = ?"
        params.append(goal_id)
    if subgoal_id:
        query += " AND s.subgoal_id = ?"
        params.append(subgoal_id)
    
    query += " ORDER BY s.date DESC, s.id DESC LIMIT ?"
    params.append(limit)
    
    rows = db.execute(query, params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/sessions", methods=["POST"])
def create_session():
    data = request.get_json()
    goal_id = data.get("goal_id")
    subgoal_id = data.get("subgoal_id")
    mins = data.get("mins", 25)
    
    if not goal_id:
        return jsonify({"error": "goal_id is required"}), 400
    
    db = get_db()
    if not db.execute("SELECT id FROM goals WHERE id=?", (goal_id,)).fetchone():
        return jsonify({"error": "goal not found"}), 404
    
    # Validate subgoal_id if provided
    if subgoal_id:
        subgoal = db.execute(
            "SELECT id, goal_id FROM subgoals WHERE id=?", 
            (subgoal_id,)
        ).fetchone()
        if not subgoal:
            return jsonify({"error": "subgoal not found"}), 404
        if subgoal["goal_id"] != goal_id:
            return jsonify({"error": "subgoal does not belong to specified goal"}), 400
    
    cur = db.execute(
        "INSERT INTO sessions (goal_id, subgoal_id, mins) VALUES (?, ?, ?)", 
        (goal_id, subgoal_id, mins)
    )
    db.commit()
    
    row = dict(db.execute(
        """
        SELECT s.*, g.title as goal_title, sg.title as subgoal_title
        FROM sessions s
        LEFT JOIN goals g ON g.id = s.goal_id
        LEFT JOIN subgoals sg ON sg.id = s.subgoal_id
        WHERE s.id = ?
        """, 
        (cur.lastrowid,)
    ).fetchone())
    
    return jsonify(row), 201


# ---------------------------------------------------------------------------
# Routes – Statistics
# ---------------------------------------------------------------------------

@app.route("/api/stats", methods=["GET"])
def get_stats():
    db = get_db()
    
    # Overall stats
    total_pomos = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    total_mins = db.execute("SELECT COALESCE(SUM(mins),0) FROM sessions").fetchone()[0]
    today_pomos = db.execute(
        "SELECT COUNT(*) FROM sessions WHERE date=date('now')"
    ).fetchone()[0]
    
    # Subgoal stats
    total_subs = db.execute("SELECT COUNT(*) FROM subgoals").fetchone()[0]
    done_subs = db.execute("SELECT COUNT(*) FROM subgoals WHERE status='done'").fetchone()[0]
    failed_subs = db.execute("SELECT COUNT(*) FROM subgoals WHERE status='failed'").fetchone()[0]
    pending_subs = total_subs - done_subs - failed_subs
    
    # Category distribution
    categories = db.execute(
        """
        SELECT category, COUNT(*) as count 
        FROM goals 
        GROUP BY category 
        ORDER BY count DESC
        """
    ).fetchall()
    
    # Stats by goal
    by_goal = db.execute(
        """
        SELECT 
            g.id, 
            g.title, 
            g.category,
            COUNT(s.id) as pomos, 
            COALESCE(SUM(s.mins),0) as mins,
            COUNT(DISTINCT sg.id) as total_subs,
            SUM(CASE WHEN sg.status='done' THEN 1 ELSE 0 END) as done_subs
        FROM goals g
        LEFT JOIN sessions s ON s.goal_id = g.id
        LEFT JOIN subgoals sg ON sg.goal_id = g.id
        GROUP BY g.id 
        ORDER BY mins DESC
        """
    ).fetchall()
    
    # Weekly trend (last 7 days)
    weekly = db.execute(
        """
        SELECT 
            date,
            COUNT(*) as pomos,
            SUM(mins) as mins
        FROM sessions
        WHERE date >= date('now', '-6 days')
        GROUP BY date
        ORDER BY date
        """
    ).fetchall()
    
    return jsonify({
        "total_pomos": total_pomos,
        "total_mins": total_mins,
        "today_pomos": today_pomos,
        "subgoal_stats": {
            "total": total_subs,
            "done": done_subs,
            "failed": failed_subs,
            "pending": pending_subs,
            "completion_rate": round((done_subs / total_subs * 100)) if total_subs > 0 else 0
        },
        "categories": [dict(c) for c in categories],
        "by_goal": [dict(g) for g in by_goal],
        "weekly_trend": [dict(w) for w in weekly]
    })


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    init_db()
    print("Starting Pomodoro Tracker at http://localhost:5000")
    app.run(debug=True, port=5000)