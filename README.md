# NAVIGO

NAVIGO is a real-time bus location demo for Mangaluru. Drivers share browser GPS data, passengers receive position updates over Socket.IO, and Google Maps renders the live map and driving route.

## Required services

Create a Google Cloud project with billing enabled, then enable these APIs:

- **Maps JavaScript API** for the passenger and driver maps.
- **Routes API** for live road distance, route geometry, and traffic-aware driving ETA.

Create two different API keys in Google Cloud:

| Variable | Purpose | Required restriction |
| --- | --- | --- |
| `GOOGLE_MAPS_API_KEY` | Loaded in the browser to show Google Maps | Website restrictions: `http://localhost:5173/*` and your deployed domain. API restriction: Maps JavaScript API. |
| `GOOGLE_ROUTES_API_KEY` | Used only by the Express server to request road routes | Server IP restriction where possible. API restriction: Routes API. Never expose this key to the browser. |

Generate a random `JWT_SECRET` with at least 32 characters. It signs user sessions.

## Run locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and add your two Google keys.
3. Run `npm.cmd install` from PowerShell, then `npm.cmd run dev`.
4. Open `http://localhost:5173`.

Create a driver account in one browser and a passenger account in another. New accounts receive a six-digit verification code by Gmail before they can sign in. Start the driver shift and approve location permission; the passenger map updates immediately.

## Gmail verification

1. Turn on 2-Step Verification for the Gmail account that will send NAVIGO emails.
2. Create a Gmail **App Password** and put the 16-character value in `GMAIL_APP_PASSWORD`.
3. Add the sending address as `GMAIL_USER`.

Never use your normal Gmail password in `.env` or commit `.env` to Git.

## Timetable data

The API loads routes, stops, buses, and timetable entries from `Navigo.xlsx`. In this local setup the supplied workbook is one folder above the project, so it is found automatically. For deployment, upload the workbook with the service and set `DATA_WORKBOOK_PATH` to its deployed path. The health endpoint reports whether the workbook was loaded.

## Deploy to Render

The included `render.yaml` and `Dockerfile` deploy the web client and Socket.IO API together, which preserves real-time connections.

1. Push this directory to a GitHub repository.
2. In Render, choose **New** → **Blueprint** and select the repository.
3. Set `GOOGLE_MAPS_API_KEY` and `GOOGLE_ROUTES_API_KEY` as secret environment variables.
4. After Render gives you a URL, set `CLIENT_ORIGIN` to that exact URL and add the URL to the browser key's website restrictions.
5. Redeploy once after updating the origin and key restrictions.

## Production limitation

The starter stores accounts and bus state in server memory. That is sufficient for a live demo but resets after a service restart and does not support multiple server instances. Before public launch, add a managed database (for example PostgreSQL) and a shared Socket.IO adapter such as Redis.
