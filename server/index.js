import crypto from 'crypto';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import XLSX from 'xlsx';
import { Server } from 'socket.io';

dotenv.config();
const app = express();
const server = http.createServer(app);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientOrigin = process.env.CLIENT_ORIGIN || true;
const secret = process.env.JWT_SECRET || 'development-only-change-me';
const io = new Server(server, { cors: { origin: clientOrigin } });
app.use(cors({ origin: clientOrigin }));
app.use(express.json({ limit: '20kb' }));

const fallbackStops = [
  ['central', 'Mangaluru Central', 12.8698, 74.842], ['hampankatta', 'Hampankatta', 12.8667, 74.8426], ['kadri', 'Kadri', 12.886, 74.8561], ['bejai', 'Bejai', 12.8916, 74.8497], ['surathkal', 'Surathkal', 13.0091, 74.7943], ['konaje', 'Konaje', 12.7986, 74.8854], ['statebank', 'State Bank', 12.866, 74.8427]
].map(([id, name, lat, lng]) => ({ id, name, lat, lng }));
const fallbackRoutes = [
  { id: '42', number: '42', name: 'Central - Surathkal', stops: ['central', 'hampankatta', 'bejai', 'surathkal'], fare: 22 },
  { id: '12', number: '12', name: 'State Bank - Konaje', stops: ['statebank', 'hampankatta', 'kadri', 'konaje'], fare: 20 }
];
const slug = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const numberFrom = value => String(value || '').match(/^\s*([^\s-]+)/)?.[1] || 'route';

function loadWorkbook() {
  const workbookPath = process.env.DATA_WORKBOOK_PATH || path.resolve(projectRoot, '..', 'Navigo.xlsx');
  try {
    const book = XLSX.readFile(workbookPath);
    const timetableSheet = book.Sheets.Sheet2;
    if (!timetableSheet) throw new Error('Sheet2 is missing');
    const rows = XLSX.utils.sheet_to_json(timetableSheet, { defval: '' });
    const headers = XLSX.utils.sheet_to_json(timetableSheet, { header: 1 })[0].slice(2).filter(Boolean);
    const known = new Map(fallbackStops.map(stop => [slug(stop.name), stop]));
    const stops = headers.map((name, index) => known.get(slug(name)) || ({ id: slug(name), name: String(name).trim(), lat: 12.86 + (index % 7) * 0.008, lng: 74.81 + Math.floor(index / 7) * 0.008 }));
    for (const stop of fallbackStops) if (!stops.some(item => item.id === stop.id)) stops.push(stop);
    const byName = new Map();
    for (const row of rows) {
      const name = String(row.Route || '').trim();
      if (!name || byName.has(name)) continue;
      byName.set(name, { id: slug(name), number: numberFrom(name), name, stops: headers.filter(header => row[header]).map(slug), fare: 20 });
    }
    const routes = [...byName.values()];
    const inventory = XLSX.utils.sheet_to_json(book.Sheets.Sheet3, { defval: '' });
    const buses = inventory.map((row, index) => ({ id: String(row['Bus ID'] || `BUS-${index + 1}`), routeId: routes.find(route => route.number === String(row['BUS NO.'] || '').trim())?.id || 'route', operator: String(row.BUS || '').trim(), occupancy: 'Tracking unavailable', lat: 12.87, lng: 74.84, updatedAt: null }));
    return { stops, routes: routes.length ? routes : fallbackRoutes, buses, rows };
  } catch (error) {
    console.warn(`Workbook not loaded: ${error.message}`);
    return { stops: fallbackStops, routes: fallbackRoutes, buses: [], rows: [] };
  }
}

const transit = loadWorkbook();
const users = new Map();
const pendingCodes = new Map();
const buses = new Map(transit.buses.map(bus => [bus.id, bus]));
const mailer = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD ? nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } }) : null;
const tokenFor = user => jwt.sign({ id: user.id, email: user.email, role: user.role }, secret, { expiresIn: '12h' });
const auth = roles => (req, res, next) => {
  try { const user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), secret); if (roles && !roles.includes(user.role)) return res.status(403).json({ message: 'Forbidden' }); req.user = user; next(); }
  catch { res.status(401).json({ message: 'Sign in required' }); }
};

function findOptions(from, to) {
  return transit.routes.flatMap(route => {
    const start = route.stops.indexOf(from); const end = route.stops.indexOf(to);
    return start >= 0 && end > start ? [{ type: 'direct', route, bus: [...buses.values()].find(bus => bus.routeId === route.id), durationMin: (end - start) * 7 }] : [];
  });
}

app.get('/api/health', (req, res) => res.json({ ok: true, workbookLoaded: transit.rows.length > 0 }));
app.get('/api/public/config', (req, res) => res.json({ googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '', routeCount: transit.routes.length, tripCount: transit.rows.length }));
app.get('/api/stops', (req, res) => res.json(transit.stops));
app.get('/api/routes', (req, res) => res.json(transit.routes));
app.get('/api/buses', (req, res) => res.json([...buses.values()]));
app.get('/api/timetable', (req, res) => res.json(transit.rows.filter(row => !req.query.route || slug(row.Route) === req.query.route).slice(0, 12)));

app.post('/api/auth/request-code', async (req, res) => {
  const { email, password, role = 'passenger' } = req.body;
  if (!/^\S+@\S+\.\S+$/.test(email) || String(password).length < 8) return res.status(400).json({ message: 'Use a valid email and an 8+ character password.' });
  if (users.has(email)) return res.status(409).json({ message: 'Account already exists. Please sign in.' });
  if (pendingCodes.get(email)?.sentAt > Date.now() - 60_000) return res.status(429).json({ message: 'Please wait a minute before requesting another code.' });
  if (!mailer) return res.status(503).json({ message: 'Email verification is not configured. Add Gmail settings to .env.' });
  const code = crypto.randomInt(100000, 1000000).toString();
  pendingCodes.set(email, { code, password: await bcrypt.hash(password, 12), role: role === 'driver' ? 'driver' : 'passenger', sentAt: Date.now(), expiresAt: Date.now() + 600000, attempts: 0 });
  try { await mailer.sendMail({ from: `NAVIGO <${process.env.GMAIL_USER}>`, to: email, subject: 'Your NAVIGO verification code', text: `Your NAVIGO verification code is ${code}. It expires in 10 minutes.`, html: `<p>Your NAVIGO verification code is</p><h1>${code}</h1><p>It expires in 10 minutes.</p>` }); res.status(202).json({ message: 'Verification code sent.' }); }
  catch (error) { pendingCodes.delete(email); console.error(error.message); res.status(502).json({ message: 'We could not send the verification email. Check your Gmail settings.' }); }
});

app.post('/api/auth/verify-code', (req, res) => {
  const pending = pendingCodes.get(req.body.email);
  if (!pending || pending.expiresAt < Date.now()) { pendingCodes.delete(req.body.email); return res.status(400).json({ message: 'This code has expired. Request a new one.' }); }
  if (++pending.attempts > 5) { pendingCodes.delete(req.body.email); return res.status(429).json({ message: 'Too many attempts. Request a new code.' }); }
  if (String(req.body.code).trim() !== pending.code) return res.status(400).json({ message: 'That verification code is incorrect.' });
  const user = { id: crypto.randomUUID(), email: req.body.email, role: pending.role, password: pending.password }; users.set(user.email, user); pendingCodes.delete(user.email);
  res.status(201).json({ token: tokenFor(user), user: { id: user.id, email: user.email, role: user.role } });
});

app.post('/api/auth/login', async (req, res) => {
  const user = users.get(req.body.email);
  if (!user || !await bcrypt.compare(req.body.password || '', user.password)) return res.status(401).json({ message: 'Incorrect email or password.' });
  res.json({ token: tokenFor(user), user: { id: user.id, email: user.email, role: user.role } });
});

app.post('/api/journeys/search', auth(['passenger']), (req, res) => {
  const origin = transit.stops.find(stop => stop.id === req.body.from); const destination = transit.stops.find(stop => stop.id === req.body.to);
  if (!origin || !destination || origin.id === destination.id) return res.status(400).json({ message: 'Choose two different valid stops.' });
  res.json({ from: origin, to: destination, options: findOptions(origin.id, destination.id), roadRoute: null, routingWarning: 'Timetable routes are loaded from Navigo.xlsx.' });
});

app.post('/api/driver/location', auth(['driver']), (req, res) => {
  const { busId, routeId, lat, lng, occupancy = 'Moderate' } = req.body;
  if (!busId || !transit.routes.some(route => route.id === routeId) || !Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ message: 'Invalid location update.' });
  const position = { id: busId, routeId, lat, lng, occupancy, updatedAt: Date.now() }; buses.set(busId, position); io.emit('bus:position', position); res.status(204).end();
});
io.on('connection', socket => socket.emit('buses:initial', [...buses.values()]));
if (process.env.NODE_ENV === 'production') { app.use(express.static(path.join(projectRoot, 'dist'))); app.get('*', (req, res) => res.sendFile(path.join(projectRoot, 'dist', 'index.html'))); }
server.listen(process.env.PORT || 3001, () => console.log(`NAVIGO server ready. Workbook data: ${transit.rows.length ? 'loaded' : 'demo mode'}.`));
