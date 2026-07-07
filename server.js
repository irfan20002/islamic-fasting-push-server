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

// ── Notify every subscriber that a new version has been deployed ─────────
// Called automatically by a GitHub Action on every push to main (see the
// deploy-notify.yml workflow in the app's repo), so this never needs to be
// triggered by hand. Protected by a shared secret so randoms can't spam
// every user's phone with a fake "update available" push.
app.post('/notify-update', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const title = req.body?.title || '🔄 App updated';
  const body  = req.body?.body  || 'A new version is ready. Please force-quit and reopen the app to get it.';
  let sent = 0, failed = 0;
  for (const [, sub] of subscriptions) {
    try {
      await sendNotif(sub, title, body);
      sent++;
    } catch (err) {
      failed++;
    }
  }
  console.log(`notify-update: sent to ${sent} subscribers, ${failed} failed`);
  res.json({ success: true, sent, failed, total: subscriptions.size });
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
      // Convert "HH:MM" strings to today's Date objects correctly
      function toDate(str) {
        const [h, m] = str.split(':').map(Number);
        // Build date string in local timezone and parse it
        const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
        const yyyy = localNow.getFullYear();
        const mm2  = String(localNow.getMonth() + 1).padStart(2, '0');
        const dd2  = String(localNow.getDate()).padStart(2, '0');
        const hh   = String(h).padStart(2, '0');
        const min  = String(m).padStart(2, '0');
        // Parse as local time by using toLocaleString trick
        return new Date(`${yyyy}-${mm2}-${dd2}T${hh}:${min}:00`);
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

// ── Hijri date calculation ────────────────────────────────────────────────
function toJD(y, m, d) {
  return Math.floor((1461*(y+4800+Math.floor((m-14)/12)))/4)
       + Math.floor((367*(m-2-12*Math.floor((m-14)/12)))/12)
       - Math.floor((3*Math.floor((y+4900+Math.floor((m-14)/12))/100))/4)
       + d - 32075;
}
function hijriToJD(hy, hm, hd) {
  return Math.floor((11*hy+3)/30) + 354*hy + 30*hm
       - Math.floor((hm-1)/2) + hd + 1948440 - 385;
}
function jdToHijri(jd) {
  const z = Math.floor(jd) + 0.5;
  const a = Math.floor((z-1948440+385)/10631);
  const b = z - Math.floor((11*a+3)/30) - 354*a - 30 + 385 - 1948440 + 385;
  const j = Math.floor((b-1)/29.5);
  return { year: a, month: j+1, day: Math.floor(b - 29.5*j) };
}
function gToH(date) {
  return jdToHijri(toJD(date.getFullYear(), date.getMonth()+1, date.getDate()));
}
function hToG(hy, hm, hd) {
  const jd = hijriToJD(hy, hm, hd);
  const l = jd + 68569;
  const n = Math.floor(4*l/146097);
  const ll = l - Math.floor((146097*n+3)/4);
  const i = Math.floor(4000*(ll+1)/1461001);
  const lll = ll - Math.floor(1461*i/4) + 31;
  const j = Math.floor(80*lll/2447);
  const d = lll - Math.floor(2447*j/80);
  const m = j + 2 - 12*Math.floor(j/11);
  const y = 100*(n-49) + i + Math.floor(j/11);
  return new Date(y, m-1, d);
}

// Check if a given Gregorian date is a named Hijri fast day
function isNamedHijriFast(date) {
  const h = gToH(date);
  const hm = h.month, hd = h.day;
  // Ashura (10 Muharram) and surrounding
  if (hm === 1 && (hd === 9 || hd === 10 || hd === 11)) return { fasting: true, name: hd === 9 ? 'Tasua' : hd === 10 ? 'Ashura' : '11 Muharram fast' };
  // Ayyam al-Beed (13, 14, 15 of each month except Ramadan)
  if (hm !== 9 && (hd === 13 || hd === 14 || hd === 15)) return { fasting: true, name: `Ayyam al-Beed` };
  // Day of Arafah (9 Dhul Hijjah)
  if (hm === 12 && hd === 9) return { fasting: true, name: 'Day of Arafah' };
  // 6 days of Shawwal (2-7 Shawwal)
  if (hm === 10 && hd >= 2 && hd <= 7) return { fasting: true, name: '6 days of Shawwal' };
  return { fasting: false };
}

function isTomorrowFasting(timezone) {
  const tomorrow = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dow = tomorrow.getDay();
  if (dow === 1 || dow === 4) return { fasting: true, name: dow === 1 ? 'Monday fast' : 'Thursday fast' };
  return isNamedHijriFast(tomorrow);
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
  const nowUTC = new Date();
  console.log(`Cron tick: ${nowUTC.toISOString()} — ${subscriptions.size} subscribers`);
  for (const [id, sub] of subscriptions) {
    try {
      const timezone = sub.timezone || 'America/Chicago';
      const nowLocal = new Date(nowUTC.toLocaleString('en-US', { timeZone: timezone }));
      const nowMin = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate(), nowLocal.getHours(), nowLocal.getMinutes(), 0, 0);
      const times = await getPrayerTimes(sub.lat, sub.lon, timezone);
      if (!times) { console.error(`No prayer times for ${id}`); continue; }
      const { fasting } = isFastingDay(nowLocal);
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
      // ── Eve reminder: 30 minutes after Maghrib if tomorrow is a fasting day ──
      if (isNow(times.Maghrib, 30)) {
        const tomorrow = isTomorrowFasting(timezone);
        if (tomorrow.fasting) {
          await sendNotif(sub, '🌙 Fast tomorrow',
            `Tomorrow is ${tomorrow.name}. Make your intention tonight. May Allah accept it.`);
        }
      }
    } catch (err) {
      console.error(`Error processing sub ${id}:`, err.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Push server running on port ${PORT}`));
