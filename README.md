# Presensi School - Smart Attendance System

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![PHP](https://img.shields.io/badge/PHP-8.1%2B-777BB4?logo=php)](https://php.net)
[![MySQL](https://img.shields.io/badge/MySQL-5.7%2B-4479A1?logo=mysql)](https://mysql.com)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker)](Dockerfile)
[![Hackathon](https://img.shields.io/badge/Open%20Agent%20Hackathon-2026-orange)](https://hackathon.genai.works)

A school attendance (presensi) web app with Face ID, GPS verification, and an
AI assistant (SmartJournal AI) powered by **Zetaris** and **Meterless Nightshift**.

> Open-source. Feel free to fork, modify, and contribute.

## Screenshots

![Dashboard](assets/screenshot-dashboard.png)
![Agent Chat](assets/screenshot-agent.png)

> Place screenshot files in `assets/` (e.g. `screenshot-dashboard.png`).

## Tech Stack
- PHP 8.3 + MySQL (Laragon/XAMPP)
- Zetaris Data Virtualization (data layer)
- Meterless Nightshift (primary AI provider)
- Python agent (see [Attendance-Agent](https://github.com/rizllxyzz/Attendance-Agent))

## Quick Start (Local)

### 1. Requirements
- PHP 8.1+ (Laragon recommended on Windows)
- MySQL 5.7+ / MariaDB 10.3+
- Docker Desktop (for Zetaris)
- Python 3.10+ (for agent, optional)

### 2. Clone & setup
```bash
git clone https://github.com/rizllxyzz/Presensi-School-App.git
cd Presensi-School-App
cp .env.example .env
```

### 3. Database
Import `database.sql` into MySQL:
```bash
mysql -u root -p presensi < database.sql
```
Or use phpMyAdmin → Import → `database.sql`.

### 4. Demo attendance data (optional)
To fill attendance for **all active students** for a full month
(weekdays, check-in + check-out), run:

```bash
php seed_absensi.php
```

Default: from the 1st of last month to today. You can also choose:

```bash
php seed_absensi.php --month=2026-09
php seed_absensi.php --from=2026-09-01 --to=2026-10-26
php seed_absensi.php --dry-run     # count only, no writes
```

Or log in as admin and open `http://localhost/seed_absensi.php`.
The script only adds missing rows — existing data is not deleted or changed.
Delete this file once the demo data is sufficient if deployed publicly.

### 5. Configure `.env`
Edit `.env`:
```
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=presensi
DB_USER=root
DB_PASS=
ZETARIS_REST_URL=http://127.0.0.1:8888/api/v1.0
ZETARIS_ORG_ID=1
ZETARIS_API_KEY=your-zetaris-api-key
```

### 6. Run
Start Laragon (Apache + MySQL), then open http://localhost.

Default admin: `admin` / (set during install).

## Zetaris Setup (Data Layer)
Zetaris virtualizes the presensi database so the agent can query it via REST.

1. Install Docker Desktop.
2. Download `zetaris-platform.zip` from Zetaris Cloud → extract to home folder.
3. Login to registry:
   ```bash
   echo 'YOUR_REGISTRY_PASSWORD' | docker login zetarishackathon.azurecr.io -u zethackuser3dbe7753d420477084dff345823c738f --password-stdin
   ```
4. Configure `.env` in zetaris-platform (minimal RAM):
   ```
   ZSPARK_DRIVER_MEM=1g
   ZSPARK_DRIVER_CORES=1
   ZSPARK_MASTER_URL=local[1]
   ZETARIS_API_MAX_HEAP=512m
   ```
5. Run:
   ```bash
   cd zetaris-platform
   docker compose pull
   docker compose up -d
   ```
6. Open http://localhost:3000 → login `admin@zetaris.com` / `Zetaris1@`.
7. Create an API key (Profile → API Keys) → copy it.
8. Set `ZETARIS_API_KEY` in this project's `.env`.
9. Test: http://localhost/admin/zetaris.php?test=1 → "Terhubung".

## Meterless Nightshift Setup (Primary AI Provider)
Nightshift provides the LLM gateway (Nemotron) for SmartJournal AI.

1. Download Nightshift from https://meterless.ai → install.
2. Create a free NVIDIA API key at https://build.nvidia.com/models.
3. In Nightshift → Providers → NVIDIA → paste key → Save.
4. Configure a lane with a Nemotron model (e.g. `nvidia/nemotron-3.5-lightning-30b-a3b`).
5. Open Nightshift Console → copy Runtime URL (e.g. `http://127.0.0.1:8088/v1`) and token.
6. Set in this project's `.env`:
   ```
   MODEL_BASE_URL=http://127.0.0.1:8088/v1
   MODEL_API_KEY=your-nightshift-runtime-token
   NEMOTRON_MODEL=meterless/auto
   ```
7. In admin panel → "Koneksi AI" → enable and pick provider (or use Nightshift as custom OpenAI-compatible).

## AI Provider Configuration (Admin)
Admins can connect any OpenAI-compatible provider without editing code:
- Go to `/admin/ai-provider.php` (menu: Koneksi AI).
- Pick provider: OpenAI, Gemini, OpenRouter, Groq, Ollama, or Custom.
- Set base URL, model, API key, enable.
- Saved to `.env`. SmartJournal AI will use it as chatbot.

## Agent (Python)
The Python agent lives in the separate repo:
https://github.com/rizllxyzz/Attendance-Agent

Run:
```bash
cd Attendance-Agent
pip install -r requirements.txt
cp .env.example .env   # fill Zetaris + Nightshift settings
python run.py           # live mode
SAMPLE_MODE=true python run.py  # sample mode (no credentials)
```

Endpoint: `POST http://localhost:8000/run` with `{"task": "..."}`.

## Sponsor Technology
- **Zetaris**: data layer. Agent queries real attendance data via REST `run_sql`. See `config/zetaris.php`.
- **Meterless Nightshift**: primary AI provider (OpenAI-compatible). See `agent/adapters/nightshift.py` (in agent repo) and admin AI provider page.
- **Meterless Engine**: Scout Intent classifies query intent for routing (`app/engines/scout_intent.py`).
- **NVIDIA**: Nemotron models routed through Nightshift.
- **Cursor**: optional AI coding tool.

## Project Structure
```
/                # PHP app (presensi)
├── admin/       # Admin panel
├── api/v1/      # REST endpoints (incl. agent/ask.php)
├── assets/      # CSS/JS
├── config/      # app-config, database, zetaris, agent-config
├── siswa/       # Student portal
├── templates/   # head/foot
└── agent/       # TS agent (HMEM) + NASKAH-VIDEO removed
```

## Limitations
- Face ID requires HTTPS or localhost (browser camera API).
- GPS verification is heuristic, not absolute.
- Sample mode uses cached data, not live queries.

## License
MIT. Free to use, modify, and distribute.