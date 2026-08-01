import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './styles.css';

const API = import.meta.env.VITE_API_URL || '/api';
const mapCenter = { lat: 12.9141, lng: 74.8560 };

function loadGoogleMaps(apiKey) {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (window.navigoMapsPromise) return window.navigoMapsPromise;
  window.navigoMapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=geometry&loading=async`;
    script.async = true;
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => reject(new Error('Google Maps could not be loaded.'));
    document.head.append(script);
  });
  return window.navigoMapsPromise;
}

function LiveMap({ buses, roadRoute, driverLocation }) {
  const elementRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const polylineRef = useRef(null);
  const [mapKey, setMapKey] = useState(null);
  const [mapError, setMapError] = useState('');

  useEffect(() => {
    fetch(`${API}/public/config`).then(response => response.json()).then(config => setMapKey(config.googleMapsKey || '')).catch(() => setMapError('Map configuration is unavailable.'));
  }, []);

  useEffect(() => {
    if (mapKey === null || !mapKey || !elementRef.current) return;
    let cancelled = false;
    loadGoogleMaps(mapKey).then(maps => {
      if (cancelled) return;
      if (!mapRef.current) mapRef.current = new maps.Map(elementRef.current, { center: mapCenter, zoom: 12, mapTypeControl: false, streetViewControl: false, fullscreenControl: false });
      const map = mapRef.current;
      const positions = driverLocation ? [{ id: 'your-location', lat: driverLocation.lat, lng: driverLocation.lng, occupancy: 'Your live location' }] : buses;
      const activeIds = new Set(positions.map(bus => bus.id));
      for (const [id, marker] of markersRef.current) if (!activeIds.has(id)) { marker.setMap(null); markersRef.current.delete(id); }
      for (const bus of positions) {
        let marker = markersRef.current.get(bus.id);
        if (!marker) {
          marker = new maps.Marker({ map, title: bus.id, label: driverLocation ? 'You' : bus.routeId || 'Bus' });
          markersRef.current.set(bus.id, marker);
        }
        marker.setPosition({ lat: bus.lat, lng: bus.lng });
      }
      if (driverLocation) map.setCenter({ lat: driverLocation.lat, lng: driverLocation.lng });
      if (polylineRef.current) polylineRef.current.setMap(null);
      if (roadRoute?.encodedPolyline && maps.geometry?.encoding) {
        polylineRef.current = new maps.Polyline({ path: maps.geometry.encoding.decodePath(roadRoute.encodedPolyline), strokeColor: '#0d7868', strokeOpacity: 0.9, strokeWeight: 5, map });
      }
    }).catch(error => setMapError(error.message));
    return () => { cancelled = true; };
  }, [mapKey, buses, roadRoute, driverLocation]);

  if (mapError) return <div className="map-fallback">{mapError}</div>;
  if (mapKey === '') return <div className="map-fallback">Add <code>GOOGLE_MAPS_API_KEY</code> to enable the live map.</div>;
  return <div ref={elementRef} className="live-map" aria-label="Live bus map" />;
}

function useLiveBuses() {
  const [buses, setBuses] = useState([]);
  useEffect(() => {
    fetch(`${API}/buses`).then(response => response.json()).then(setBuses).catch(() => {});
    const socket = io({ path: '/socket.io' });
    socket.on('buses:initial', setBuses);
    socket.on('bus:position', position => setBuses(current => [...current.filter(bus => bus.id !== position.id), position]));
    return () => socket.close();
  }, []);
  return buses;
}

function Auth({ onDone }) {
  const [mode, setMode] = useState('login');
  const [role, setRole] = useState('passenger');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const response = await fetch(`${API}/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, role }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      localStorage.setItem('navigo_session', JSON.stringify(data));
      onDone(data);
    } catch (requestError) { setError(requestError.message); } finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="brand"><div className="logo">N</div><h1>NAVIGO</h1><p>Live Mangaluru bus intelligence.</p></section><form onSubmit={submit} className="card auth-card"><div className="role-switch"><button type="button" className={role === 'passenger' ? 'active' : ''} onClick={() => setRole('passenger')}>Passenger</button><button type="button" className={role === 'driver' ? 'active' : ''} onClick={() => setRole('driver')}>Driver</button></div><h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2><label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} required placeholder="you@example.com" /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} minLength="8" required placeholder="At least 8 characters" /></label>{error && <p className="error">{error}</p>}<button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button><button type="button" className="text-button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}</button></form></main>;
}

function AuthV2({ onDone }) {
  const [mode, setMode] = useState('login');
  const [role, setRole] = useState('passenger');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const verifyMode = mode === 'verify';
  async function request(url, body) {
    const response = await fetch(`${API}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Something went wrong.');
    return data;
  }
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      if (mode === 'login') {
        const data = await request('/auth/login', { email, password });
        localStorage.setItem('navigo_session', JSON.stringify(data)); onDone(data); return;
      }
      if (mode === 'register') {
        const data = await request('/auth/request-code', { email, password, role });
        setMessage(data.message); setMode('verify'); return;
      }
      const data = await request('/auth/verify-code', { email, code });
      localStorage.setItem('navigo_session', JSON.stringify(data)); onDone(data);
    } catch (requestError) { setError(requestError.message); } finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="brand"><div className="logo">N</div><div className="eyebrow">MANGALURU, IN MOTION</div><h1>Every journey, <em>clearer.</em></h1><p>Find your bus, follow it live, and move with confidence.</p><div className="trust-list"><span>Live route updates</span><span>Verified accounts</span><span>Smart timetable search</span></div></section><form onSubmit={submit} className="card auth-card"><div className="auth-heading"><span className="mini-logo">N</span><div><h2>{verifyMode ? 'Check your inbox' : mode === 'login' ? 'Welcome back' : 'Create your account'}</h2><p>{verifyMode ? `We sent a six-digit code to ${email}.` : mode === 'login' ? 'Sign in to continue your journey.' : 'A quick verification keeps NAVIGO trusted.'}</p></div></div>{!verifyMode && <><div className="role-switch"><button type="button" className={role === 'passenger' ? 'active' : ''} onClick={() => setRole('passenger')}>Passenger</button><button type="button" className={role === 'driver' ? 'active' : ''} onClick={() => setRole('driver')}>Driver</button></div><label>Email address<input type="email" value={email} onChange={event => setEmail(event.target.value)} required placeholder="you@gmail.com" autoComplete="email" /></label><label>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} minLength="8" required placeholder="At least 8 characters" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label></>}{verifyMode && <label>Verification code<input className="code-input" inputMode="numeric" maxLength="6" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} required placeholder="123456" autoComplete="one-time-code" /></label>}{message && <p className="success">{message}</p>}{error && <p className="error">{error}</p>}<button className="primary wide" disabled={busy}>{busy ? 'Please wait...' : verifyMode ? 'Verify and continue' : mode === 'login' ? 'Sign in securely' : 'Send verification code'}</button>{verifyMode ? <button type="button" className="text-button" onClick={() => { setMode('register'); setCode(''); }}>Use a different email</button> : <button type="button" className="text-button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'New to NAVIGO? Create an account' : 'Already have an account? Sign in'}</button>}<p className="terms">By continuing, you agree to use live location responsibly.</p></form></main>;
}

function Route({ option }) {
  if (option.type === 'connection') return <article className="route-card"><strong><span className="bus-badge">{option.first.number}</span> → {option.transfer.name} → <span className="bus-badge">{option.second.number}</span></strong><span>{option.durationMin} min · one change</span></article>;
  return <article className="route-card"><strong><span className="bus-badge">{option.route.number}</span> {option.route.name}</strong><span>{option.durationMin} min · {option.bus?.occupancy || 'Tracking unavailable'} · ₹{option.route.fare}</span></article>;
}

function Passenger({ session, onLogout }) {
  const buses = useLiveBuses();
  const [stops, setStops] = useState([]);
  const [from, setFrom] = useState('central');
  const [to, setTo] = useState('surathkal');
  const [journey, setJourney] = useState(null);
  const [message, setMessage] = useState('');
  useEffect(() => { fetch(`${API}/stops`).then(response => response.json()).then(setStops).catch(() => setMessage('Unable to load stops.')); }, []);
  async function search() {
    setMessage('Finding routes…');
    const response = await fetch(`${API}/journeys/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ from, to }) });
    const data = await response.json();
    if (!response.ok) { setMessage(data.message); return; }
    setJourney(data); setMessage(data.routingWarning || (data.roadRoute ? `Live road ETA: ${Math.ceil(data.roadRoute.durationSeconds / 60)} min` : 'Add a Google Routes key for live road ETA.'));
  }
  return <main><header><div className="wordmark">NAVIGO <small>LIVE</small></div><button className="text-button" onClick={onLogout}>Sign out</button></header><section className="hero"><span>LIVE BUS INTELLIGENCE</span><h1>Where are you headed?</h1><p>Driver locations update live as they are shared.</p></section><section className="card search"><label>From<select value={from} onChange={event => setFrom(event.target.value)}>{stops.map(stop => <option key={stop.id} value={stop.id}>{stop.name}</option>)}</select></label><label>To<select value={to} onChange={event => setTo(event.target.value)}>{stops.map(stop => <option key={stop.id} value={stop.id}>{stop.name}</option>)}</select></label><button className="primary" onClick={search}>Find buses</button></section><section className="map-section"><LiveMap buses={buses} roadRoute={journey?.roadRoute} /><div className="map-status">● {buses.length} buses broadcasting</div></section><section className="results"><h2>{journey ? 'Your routes' : 'Live buses'}</h2>{message && <p className="notice">{message}</p>}{journey?.options.map((option, index) => <Route key={index} option={option} />) || buses.map(bus => <article className="route-card" key={bus.id}><strong>{bus.id} · Route {bus.routeId}</strong><span>{bus.occupancy} · updated {new Date(bus.updatedAt).toLocaleTimeString()}</span></article>)}</section></main>;
}

function Driver({ session, onLogout }) {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('Ready to start');
  const [busId, setBusId] = useState('KA19AB2410');
  const [location, setLocation] = useState(null);
  useEffect(() => {
    if (!active) return undefined;
    if (!navigator.geolocation) { setStatus('This browser does not support location sharing.'); return undefined; }
    const watchId = navigator.geolocation.watchPosition(async position => {
      const nextLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
      setLocation(nextLocation);
      try {
        const response = await fetch(`${API}/driver/location`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ busId, routeId: '42', ...nextLocation, occupancy: 'Moderate' }) });
        if (!response.ok) throw new Error('Location update was rejected.');
        setStatus(`Broadcasting location · ${new Date().toLocaleTimeString()}`);
      } catch (error) { setStatus(error.message); }
    }, () => setStatus('Location permission denied. Enable it to go live.'), { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
    return () => navigator.geolocation.clearWatch(watchId);
  }, [active, busId, session.token]);
  return <main><header><div className="wordmark">NAVIGO DRIVER</div><button className="text-button" onClick={onLogout}>Sign out</button></header><section className="hero"><span>OPERATOR CONSOLE</span><h1>Share your bus location.</h1><p>Passengers see your location immediately.</p></section><section className="card shift"><div><strong>{active ? '● Live shift in progress' : '○ Shift not started'}</strong><p className="notice">{status}</p></div><label>Bus ID<input value={busId} onChange={event => setBusId(event.target.value.toUpperCase())} /></label><button className={active ? 'danger' : 'primary'} onClick={() => { setActive(current => !current); setStatus(active ? 'Shift ended' : 'Requesting location permission…'); }}>{active ? 'End live shift' : 'Start live shift'}</button></section><section className="map-section"><LiveMap buses={[]} driverLocation={location} /></section></main>;
}

function App() {
  const [session, setSession] = useState(() => JSON.parse(localStorage.getItem('navigo_session') || 'null'));
  const logout = () => { localStorage.removeItem('navigo_session'); setSession(null); };
  if (!session) return <AuthV2 onDone={setSession} />;
  return session.user.role === 'driver' ? <Driver session={session} onLogout={logout} /> : <Passenger session={session} onLogout={logout} />;
}

createRoot(document.getElementById('root')).render(<App />);
