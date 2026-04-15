# Pomodoro Tracker

A local productivity app with goals, sub-goals, and Pomodoro time tracking.
Built with Python (Flask) + SQLite backend and a vanilla JS/HTML frontend.

---

## Setup

**Requirements:** Python 3.8+

```bash
# 1. Navigate to the project folder
cd pomodoro_app

# 2. Create and activate a virtual environment (recommended)
python -m venv venv

# macOS / Linux
source venv/bin/activate

# Windows
venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Run the app
python app.py
```

Then open <http://localhost:5000> in your browser.

The SQLite database file (`pomodoro.db`) is created automatically on first run
in the same directory as `app.py`. Your data persists between sessions.

---

## Project structure

```txt
pomodoro_app/
├── app.py                  # Flask backend + SQLite logic
├── requirements.txt
├── pomodoro.db             # Created automatically on first run
├── templates/
│   └── index.html          # Main HTML page
└── static/
    ├── css/
    │   └── style.css
    └── js/
        └── app.js          # All frontend logic (talks to the API)
```

---

## API endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/goals` | List all goals with sub-goals and session stats |
| POST | `/api/goals` | Create a goal |
| PATCH | `/api/goals/<id>` | Update a goal (title, done, category, note) |
| DELETE | `/api/goals/<id>` | Delete a goal (cascades to sub-goals and sessions) |
| POST | `/api/goals/<id>/subgoals` | Add a sub-goal to a goal |
| PATCH | `/api/subgoals/<id>` | Update sub-goal status (pending / done / failed) |
| DELETE | `/api/subgoals/<id>` | Delete a sub-goal |
| GET | `/api/sessions` | List all Pomodoro sessions |
| POST | `/api/sessions` | Log a completed Pomodoro session |
| GET | `/api/stats` | Aggregate stats (totals, by-goal, sub-goal %) |

---

## TODOs: Advanced Features and Functionality

---
