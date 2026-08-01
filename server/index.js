import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Server } from 'socket.io';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured in production.');
}

const app = express();
const server = http.createServer(app);
const clientOrigin = process.env.CLIENT_ORIGIN || true;
const io = new Server(server, { cors: { origin: clientOrigin } });
const secret = process.env.JWT_SECRET || 'development-only-change-me';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

app.use(cors({ origin: clientOrigin }));
app.use(express.json({ limit: '20kb' }));

const stops = [
  { id: 'central', name: 'Mangaluru Central', lat: 12.8698, lng: 74.8420 },
  { id: 'hampankatta', name: 'Hampankatta', lat: 12.8667, lng: 74.8426 },
  { id: 'kadri', name: 'Kadri', lat: 12.8860, lng: 74.8561 },
  { id: 'bejai', name: 'Bejai', lat: 12.8916, lng: 74.8497 },
  { id: 'surathkal', name: 'Surathkal', lat: 13.0091, lng: 74.7943 },
  { id: 'konaje', name: 'Konaje', lat: 12.7986, lng: 74.8854 },
  { id: 'statebank', name: 'State Bank', lat: 12.8660, lng: 74.8427 }
];
const routes = [
  { id: '42', number: '42', name: 'Central ↔ Surathkal', stops: ['central', 'hampankatta', 'bejai', 'surathkal'], fare: 22 },
  { id: '12', number: '12', name: 'State Bank ↔ Konaje', stops: ['statebank', 'hampankatta', 'kadri', 'konaje'], fare: 20 },
  { id: '24', number: '24', name: 'Central ↔ Kadri', stops: ['central', 'statebank', 'kadri'], fare: 14 }
];
const buses = new Map([
  ['KA19AB2410', { id: 'KA19AB2410', routeId: '42', occupancy: 'Moderate', lat: 12.930, lng: 74.826, updatedAt: Date.now() }],
  ['KA19AB1288', { id: 'KA19AB1288', routeId: '12', occupancy: 'Seats available', lat: 12.838, lng: 74.869, updatedAt: Date.now() }]
]);
const users = new Map();

const sign = user => jwt.sign({ id: user.id, email: user.email, role: user.role }, secret, { expiresIn: '12h' });
const auth = roles => (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const payload = jwt.verify(token, secret);
    if (roles && !roles.includes(payload.role)) return res.status(403).json({ message: 'Forbidden' });
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ message: 'Sign in required' });
  }
};

function routeOptions(from, to) {
  const direct = [];
  const connections = [];
  for (const route of routes) {
    const originIndex = route.stops.indexOf(from);
    const destinationIndex = route.stops.indexOf(to);
    if (originIndex >= 0 && destinationIndex > originIndex) {
      direct.push({ type: 'direct', route, bus: [...buses.values()].find(bus => bus.routeId === route.id), durationMin: (destinationIndex - originIndex) * 9 });
    }
  }
  if (!direct.length) {
    for (const first of routes) for (const second of routes) {
      const originIndex = first.stops.indexOf(from);
      const destinationIndex = second.stops.indexOf(to);
      if (originIndex < 0 || destinationIndex < 0) continue;
      for (const transferId of first.stops.slice(originIndex + 1)) {
        const transferIndex = second.stops.indexOf(transferId);
        if (transferIndex >= 0 && destinationIndex > transferIndex) {
          connections.push({ type: 'connection', first, second, transfer: stops.find(stop => stop.id === transferId), durationMin: (first.stops.indexOf(transferId) - originIndex + destinationIndex - transferIndex) * 9 + 7 });
        }
      }
    }
  }
  return [...direct, ...connections];
}

async function getRoadRoute(origin, destination) {
  const apiKey = process.env.GOOGLE_ROUTES_API_KEY;
  if (!apiKey) return null;
  const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE'
    })
  });
  if (!response.ok) throw new Error(`Google Routes API returned ${response.status}`);
  const data = await response.json();
  const route = data.routes?.[0];
  if (!route) return null;
  return {
    distanceMeters: route.distanceMeters,
    durationSeconds: Number.parseInt(route.duration, 10),
    encodedPolyline: route.polyline?.encodedPolyline || null,
    provider: 'Google Routes API'
  };
}

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/public/config', (req, res) => res.json({ googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '' }));
app.get('/api/stops', (req, res) => res.json(stops));
app.get('/api/buses', (req, res) => res.json([...buses.values()]));
app.get('/api/routes', (req, res) => res.json(routes));

app.post('/api/auth/register', async (req, res) => {
  const { email, password, role = 'passenger' } = req.body;
  if (!/^\S+@\S+\.\S+$/.test(email) || String(password).length < 8) return res.status(400).json({ message: 'Use a valid email and an 8+ character password.' });
  if (users.has(email)) return res.status(409).json({ message: 'Account already exists.' });
  const user = { id: crypto.randomUUID(), email, role: role === 'driver' ? 'driver' : 'passenger', password: await bcrypt.hash(password, 12) };
  users.set(email, user);
  res.status(201).json({ token: sign(user), user: { id: user.id, email, role: user.role } });
});

app.post('/api/auth/login', async (req, res) => {
  const user = users.get(req.body.email);
  if (!user || !await bcrypt.compare(req.body.password || '', user.password)) return res.status(401).json({ message: 'Incorrect email or password.' });
  res.json({ token: sign(user), user: { id: user.id, email: user.email, role: user.role } });
});

app.post('/api/journeys/search', auth(['passenger']), async (req, res) => {
  const { from, to } = req.body;
  const origin = stops.find(stop => stop.id === from);
  const destination = stops.find(stop => stop.id === to);
  if (!origin || !destination || from === to) return res.status(400).json({ message: 'Choose two different valid stops.' });
  let roadRoute = null;
  let routingWarning = null;
  try {
    roadRoute = await getRoadRoute(origin, destination);
  } catch (error) {
    routingWarning = 'Live road travel time is temporarily unavailable.';
    console.error(error.message);
  }
  res.json({ from: origin, to: destination, options: routeOptions(from, to), roadRoute, routingWarning });
});

app.post('/api/driver/location', auth(['driver']), (req, res) => {
  const { busId, routeId, lat, lng, occupancy = 'Moderate' } = req.body;
  if (!busId || !routes.some(route => route.id === routeId) || !Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ message: 'Invalid location update.' });
  const position = { id: busId, routeId, lat, lng, occupancy, updatedAt: Date.now() };
  buses.set(busId, position);
  io.emit('bus:position', position);
  res.status(204).end();
});

io.on('connection', socket => socket.emit('buses:initial', [...buses.values()]));

if (isProduction) {
  app.use(express.static(path.join(projectRoot, 'dist')));
  app.get('*', (req, res) => res.sendFile(path.join(projectRoot, 'dist', 'index.html')));
}

server.listen(process.env.PORT || 3001, () => console.log('NAVIGO API running'));
