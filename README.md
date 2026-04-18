# Timetable Generator

This project is a Flask timetable builder configured for a split deployment: Netlify serves the public site and proxies requests, while a separate backend host runs Flask and PostgreSQL.

## Included Deployment Files

- `Dockerfile` for container-based hosting
- `render.yaml` for a Render web service plus Render Postgres
- `netlify.toml` for Netlify site configuration
- `netlify/functions/backend-proxy.mjs` for proxying app routes from Netlify to the backend
- `wsgi.py` as the production entrypoint
- `.env.example` for required environment variables
- `/health` endpoint for deployment health checks

## Repository Layout

- `app.py` is the small local development launcher.
- `backend/` contains the real Flask application code.
- `frontend/templates/` contains the HTML templates.
- `frontend/static/` contains CSS and browser-side JavaScript.

## Required Environment Variables

- `APP_ENV=production`
- `SECRET_KEY=<long random secret>`
- `DATABASE_URL=<postgresql connection string>`
- `NETLIFY_BACKEND_ORIGIN=<https backend origin for Netlify to proxy to>`
- `PORT=<provided by your host or 8000 locally>`
- `SESSION_COOKIE_SECURE=true`

## Local Run

1. Copy `.env.example` to `.env`.
2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Provide a PostgreSQL `DATABASE_URL` in `.env`.
4. Start the app:

```bash
python app.py
```

## Backend Deployment

Deploy the Flask backend to a Python host that supports Docker or WSGI. The repo already includes a Render setup.

1. Push this repo to GitHub.
2. In Render, create a new Blueprint and point it at this repository.
3. Render will create:
   - a Docker-based web service from `Dockerfile`
   - a managed Postgres database from `render.yaml`
4. During setup, confirm the generated `SECRET_KEY`.
5. After the first deploy, open the backend service URL and verify `/health`.
6. If the Render service name `utable-backend` is available, the backend URL will usually be `https://utable-backend.onrender.com`.
7. Keep this backend on its Render URL or a backend-only subdomain. If Netlify is your public site, your main site domain should point to Netlify, not Render.

## Netlify Deployment

Netlify is the public entrypoint for this project, but not the Python runtime. Netlify serves the `/static` assets from `frontend/` and proxies `/`, `/health`, `/login`, `/register`, `/index`, `/logout`, and `/api/*` to your backend origin through `netlify/functions/backend-proxy.mjs`.

1. Deploy the backend first and copy its HTTPS base URL.
2. In Netlify, create a new site from this repo.
3. Set the environment variable `NETLIFY_BACKEND_ORIGIN` to your backend origin.
   If Render gives you the default service URL, this will likely be `https://utable-backend.onrender.com`.
4. Netlify will read `netlify.toml` and publish the `frontend/` directory.
5. After deploy, test:
   - `https://utable-backend.onrender.com/health` on the backend
   - `https://utable.netlify.app/` on Netlify
   - login, register, course search, and save/load behavior on Netlify
6. Add your custom domain to Netlify if you want Netlify to be the public site domain.

## Notes

- The app needs outbound internet access so it can query the U of T TTB and calendar endpoints.
- As of Netlify's current official docs, Netlify Functions support TypeScript, JavaScript, and Go, not Python. That is why this setup keeps the Flask app on a separate backend host and uses a Netlify proxy function.
- `render.yaml` currently uses free Render plans as a safe default so you do not get surprise charges.
- Render free Postgres is not a long-term production database. Upgrade the database plan before serious public use.

## If You Want To Upgrade Plans

- In `render.yaml`, change the web service plan or database plan after your first test deploy.
- Render's official Blueprint reference currently lists database plan values such as `free`, `basic-256mb`, and `basic-1gb`.
