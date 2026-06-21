const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// VAPID keys
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BOAaqCPlyrXIiDpWE55EWQFbao6e5jEAmDKeB91s8TUMKAXMpASUj59cIwFqGa25QSb3Q9wsed819mVkmR0Uqlw';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '_r9Ik842T_VBPXzT3udxNum-yDq4IZ0iRGH6YHjJ9ms';

webpush.setVapidDetails('mailto:irfanbandey@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://hbaynzxowrcgvogafsuz.supabase.co',
  process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhiYXluenhvd3JjZ3ZvZ2Fmc3V6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NzY3MjksImV4cCI6MjA5NzQ1MjcyOX0.NCSrcu22bT_7eW8xsjQtpzMBsu7AStx0Wath7tWh9cQ'
);

// In-memory cache (populated from DB on startup)
const subscriptions = new Map();

async function loadSubscriptions() {
  const { data, error } = await supabase.from('subscriptions').select('*');
  if (error) { console.error('Failed to load subscriptions:', error.message); return; }
  for (const row of data) {
    subscriptions.set(row.id, {
      subscription: row.subscription,
      lat: row.lat,
      lon: row.lon,
      timezone: row.timezone
    });
  }
  console.log(`Loaded ${subscriptions.size} subscriptions from Supabase`);
}

loadSubscriptions();

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

app.post('/subscribe', async (req, res) => {
  const { subscription, lat, lon, timezone } = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  const id = subscription.endpoint.slice(-20);
  const record = { id, subscription, lat: parseFloat(lat), lon: parseFloat(lon), timezone: timezone || 'America/Chicago' };
  subscriptions.set(id, { subscription, lat: record.lat, lon: record.lon, timezone: record.timezone });
  const { error } = await supabase.from('subscriptions').upsert(record, { onConflict: 'id' });
  if (error) console.error('Supabase upsert error:', error.message);
  console.log(`Subscribed: ${id} (${lat}, ${lon})`);
  res.json({ success: true, id });
});

app.post('/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  const id = endpoint?.slice(-20);
  if (id) {
    subscriptions.delete(id);
    await supabase.from('subscriptions').delete().eq('id', id);
  }
  res.json({ success: true });
});

// ── Prayer time fetching via Al-Adhan API ────────────────────────────────

const prayerCache = new Map(); // key: "lat_lon_date" → timings object

async function getPrayerTimes(lat, lon, timezone) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  const dd  = String(now.getDate()).padStart(2, '0');
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const key = `${Math.round(lat*100)}_${Math.round(lon*100)}_${dd}${mm}${yyyy}`;

  if (prayerCache.has(key)) return prayerCache.get(key);

  try {
    const res = await fetch(`https://api.aladhan.com/v1/timings/${dd}-${mm}-${yyyy}?latitude=${lat}&longitude=${lon}&method=2`);
    const data = await res.json();
    if (data.code === 200) {
      const timings = data.data.timings;
      // Convert "HH:MM" strings to today's Date objects in local timezone
      function toDate(str) {
        const [h, m] = str.split(':').map(Number);
        const d = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
        d.setHours(h, m, 0, 0);
        return d;
      }
      const result = {
        Fajr:     toDate(timings.Fajr),
        Sunrise:  toDate(timings.Sunrise),
        Ishraq:   new Date(toDate(timings.Sunrise).getTime() + 25 * 60000),
        Dhuhr:    toDate(timings.Dhuhr),
        Asr:      toDate(timings.Asr),
        Maghrib:  toDate(timings.Maghrib),
        Isha:     toDate(timings.Isha),
        Midnight: toDate(timings.Midnight),
      };
      prayerCache.set(key, result);
      // Clear cache at midnight
      setTimeout(() => prayerCache.delete(key), 24 * 60 * 60 * 1000);
      return result;
    }
  } catch (err) {
    console.error('Prayer API error:', err.message);
  }
  return null;
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
      await supabase.from('subscriptions').delete().eq('id', id);
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
      const timezone = sub.timezone || 'America/Chicago';
      const times = await getPrayerTimes(sub.lat, sub.lon, timezone);
      if (!times) { console.error(`No prayer times for ${id}`); continue; }
      const { fasting } = isFastingDay(now);
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
    } catch (err) {
      console.error(`Error processing sub ${id}:`, err.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Push server running on port ${PORT}`));
