const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// VAPID keys
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BOAaqCPlyrXIiDpWE55EWQFbao6e5jEAmDKeB91s8TUMKAXMpASUj59cIwFqGa25QSb3Q9wsed819mVkmR0Uqlw';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '_r9Ik842T_VBPXzT3udxNum-yDq4IZ0iRGH6YHjJ9ms';

webpush.setVapidDetails('mailto:irfanbandey@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

const subscriptions = new Map();

// ── Routes ────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'Islamic Fasting Calendar Push Server running' }));

app.get('/vapid-public-key', (req, res) => res.json({ key: VAPID_PUBLIC }));

// List subscribers (for debugging)
app.get('/subscribers', (req, res) => {
  const list = [...subscriptions.entries()].map(([id, sub]) => ({
    id,
    lat: sub.lat,
    lon: sub.lon,
    timezone: sub.timezone,
    endpoint_tail: sub.subscription.endpoint.slice(-30)
  }));
  res.json({ count: list.length, subscribers: list });
});

app.post('/subscribe', (req, res) => {
  const { subscription, lat, lon, timezone } = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const id = subscription.endpoint.slice(-20);
  subscriptions.set(id, { subscription, lat: parseFloat(lat), lon: parseFloat(lon), timezone: timezone || 'America/Chicago' });
  console.log(`Subscribed: ${id} (${lat}, ${lon})`);
  res.json({ success: true, id });
});

app.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  const id = endpoint?.slice(-20);
  if (id) subscriptions.delete(id);
  res.json({ success: true });
});

// ── Prayer time calculation ───────────────────────────────────────────────

function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }

function calcPrayerTimes(lat, lon, date) {
  const JD = Math.floor(365.25 * (date.getFullYear() + 4716)) +
             Math.floor(30.6001 * (date.getMonth() + 2)) +
             date.getDate() - 1524.5;
  const D = JD - 2451545.0;
  const g = toRad((357.529 + 0.98560028 * D) % 360);
  const q = (280.459 + 0.98564736 * D) % 360;
  const L = toRad((q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) % 360);
  const e = toRad(23.439 - 0.00000036 * D);
  const RA = toDeg(Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L))) / 15;
  const EqT = q / 15 - ((RA + 360) % 24);
  const decl = Math.asin(Math.sin(e) * Math.sin(L));
  const noon = 12 - EqT - lon / 15;
  function hourAngle(alt) {
    const cosH = (Math.sin(toRad(alt)) - Math.sin(toRad(lat)) * Math.sin(decl)) /
                 (Math.cos(toRad(lat)) * Math.cos(decl));
    if (cosH > 1 || cosH < -1) return 0;
    return toDeg(Math.acos(cosH)) / 15;
  }
  const asrAlt = toDeg(Math.atan(1 / (1 + Math.tan(Math.abs(toRad(lat) - decl)))));
  const fajrHA    = hourAngle(-18);
  const sunriseHA = hourAngle(-0.833);
  const asrHA     = hourAngle(asrAlt);
  const maghribHA = sunriseHA;
  const ishaHA    = hourAngle(-17);
  function toDate(h) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setMinutes(Math.round(h * 60));
    return d;
  }
  const sunrise = noon - sunriseHA;
  const ishraqStart = sunrise + 25/60;
  const midnight = noon + 12;
  const lastThird = (midnight + (noon - fajrHA + 24)) / 2;
  return {
    Fajr:     toDate(noon - fajrHA),
    Sunrise:  toDate(sunrise),
    Ishraq:   toDate(ishraqStart),
    Dhuhr:    toDate(noon),
    Asr:      toDate(noon + asrHA),
    Maghrib:  toDate(noon + maghribHA),
    Isha:     toDate(noon + ishaHA),
    Tahajjud: toDate(lastThird - 15/60),
    Midnight: toDate(midnight),
  };
}

function isFastingDay(date) {
  const dow = date.getDay();
  if (dow === 1 || dow === 4) return { fasting: true, name: dow === 1 ? 'Monday fast' : 'Thursday fast' };
  return { fasting: false };
}

async function sendNotif(sub, title, body) {
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify({
      title, body,
      icon: 'https://irfan20002.github.io/islamic-calendar-test/icon-192.png',
      badge: 'https://irfan20002.github.io/islamic-calendar-test/icon-192.png',
    }));
    console.log(`Sent "${title}" to ${sub.subscription.endpoint.slice(-10)}`);
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      const id = sub.subscription.endpoint.slice(-20);
      subscriptions.delete(id);
      console.log(`Removed expired subscription ${id}`);
    } else {
      console.error('Push error:', err.message);
    }
  }
}

cron.schedule('* * * * *', async () => {
  const now = new Date();
  const nowMin = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0);
  for (const [id, sub] of subscriptions) {
    try {
      const times = calcPrayerTimes(sub.lat, sub.lon, now);
      const { fasting, name: fastName } = isFastingDay(now);
      function isNow(t, offsetMins = 0) {
        if (!t) return false;
        const target = new Date(t.getTime() + offsetMins * 60000);
        return Math.abs(target - nowMin) < 60000;
      }
      if (fasting && isNow(times.Fajr, -30))
        await sendNotif(sub, '🍽️ Suhoor time', `Fajr in 30 minutes (${times.Fajr.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'})}). Eat and make your intention.`);
      if (isNow(times.Fajr, -15))
        await sendNotif(sub, '🌅 Fajr in 15 minutes', `Fajr at ${times.Fajr.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'})}.${fasting ? ' Stop eating soon.' : ''}`);
      if (isNow(times.Ishraq, -15))
        await sendNotif(sub, '🌄 Ishraq/Duha in 15 minutes', `Ishraq time starts at ${times.Ishraq.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'})}.`);
      if (isNow(times.Dhuhr, -15))
        await sendNotif(sub, '🕌 Dhuhr in 15 minutes', `Dhuhr at ${times.Dhuhr.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'})}.`);
      if (isNow(times.Asr, -15))
        await sendNotif(sub, '🕌 Asr in 15 minutes', `Asr at ${times.Asr.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'})}.`);
      if (isNow(times.Maghrib))
        await sendNotif(sub, fasting ? '🌙 Iftar time!' : '🌅 Maghrib time',
          fasting ? `Maghrib at ${times.Maghrib.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'})}. Break your fast. Allahu Akbar!`
                  : `Maghrib at ${times.Maghrib.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'})}.`);
      if (isNow(times.Isha, -15))
        await sendNotif(sub, '🌙 Isha in 15 minutes', `Isha at ${times.Isha.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'})}.`);
      if (isNow(times.Tahajjud))
        await sendNotif(sub, '🌙 Last third of night in 15 minutes', `Pray Tahajjud starting ${new Date(times.Tahajjud.getTime() + 15*60000).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'})}.`);
    } catch (err) {
      console.error(`Error processing sub ${id}:`, err.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Push server running on port ${PORT}`));
