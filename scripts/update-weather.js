// update-weather.js
// ---------------------------------------------------------------------------
// Rewrites the "forecast discussion" block on the Weather tab of index.html
// using a real multi-day forecast from Open-Meteo (free, no API key).
//
// This does NOT call any AI model — it assembles natural-sounding sentences
// from real numbers using a template with some day-to-day phrase variety.
// It is honest, accurate, and fully automatic — but it is not the same as a
// human forecaster's judgment. See the SOP for what that tradeoff means.
//
// Run manually with:  node scripts/update-weather.js
// Run automatically by: .github/workflows/update-weather.yml (nightly cron)
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const LAT = 29.56;
const LON = -92.40; // Pecan Island, Vermilion Parish, LA
const INDEX_PATH = path.join(__dirname, '..', 'index.html');

const START_MARK = '<!-- AUTO-DISCUSSION:START';
const END_MARK = '<!-- AUTO-DISCUSSION:END -->';

// ---- weather-code buckets (WMO codes, same table Open-Meteo uses) ---------
const BUCKETS = {
  clear:   { codes: [0, 1],         label: 'clear' },
  partly:  { codes: [2],            label: 'partly cloudy' },
  overcast:{ codes: [3],            label: 'overcast' },
  fog:     { codes: [45, 48],       label: 'foggy' },
  drizzle: { codes: [51, 53, 55],   label: 'drizzly' },
  rain:    { codes: [61, 63, 65, 80, 81, 82], label: 'rainy' },
  storm:   { codes: [95, 96, 99],   label: 'stormy' },
  snow:    { codes: [71, 73, 75],   label: 'wintry' }, // essentially never fires in LA
};

function bucketFor(code) {
  for (const [key, b] of Object.entries(BUCKETS)) {
    if (b.codes.includes(code)) return key;
  }
  return 'partly';
}

// Deterministic "randomness" seeded by date, so wording varies day-to-day but
// is stable if the workflow re-runs the same day.
function cap(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function pick(arr, seedStr) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

const PHRASES = {
  clear:   ['clear', 'wide open', 'bright and clear'],
  partly:  ['partly cloudy', 'a mix of sun and clouds', 'partly clear'],
  overcast:['mostly overcast', 'socked in with cloud cover', 'gray and overcast'],
  fog:     ['foggy, especially early', 'patchy fog to start'],
  drizzle: ['drizzly', 'damp with light drizzle'],
  rain:    ['rainy', 'wet, with periods of rain'],
  storm:   ['unsettled, with thunderstorms possible'],
  snow:    ['unusually wintry'],
};

const LAUNCH_GOOD = ['a favorable window for anyone hoping to see a launch', 'good visibility if a launch window falls today', 'nothing in the sky to get in the way of a launch'];
const LAUNCH_WATCH = ['worth double-checking closer to any launch window', 'cloud cover is the thing to track if a launch is scheduled', 'keep an eye on this before heading out for a launch'];

async function fetchForecast() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago&forecast_days=8`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo request failed: ${res.status}`);
  const data = await res.json();
  return data.daily;
}

function dayName(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
}

function buildDiscussion(daily) {
  const days = daily.time.map((date, i) => ({
    date,
    weekday: dayName(date),
    code: daily.weathercode[i],
    hi: Math.round(daily.temperature_2m_max[i]),
    lo: Math.round(daily.temperature_2m_min[i]),
    rainPct: daily.precipitation_probability_max[i],
    windMax: Math.round(daily.wind_speed_10m_max[i]),
  })).map(d => ({ ...d, bucket: bucketFor(d.code) }));

  const today = days[0];
  const seed = today.date;

  // find the next Sat/Sun within the fetched window
  const weekend = days.filter(d => d.weekday === 'Saturday' || d.weekday === 'Sunday');
  const beyond = days.filter(d => !weekend.includes(d) && d.date !== today.date);

  const anyRainSoon = days.slice(0, 4).some(d => ['rain', 'storm', 'drizzle'].includes(d.bucket));
  const anyWindySoon = days.slice(0, 4).some(d => d.windMax >= 20);

  // ---- In brief ----
  let brief;
  if (anyRainSoon) {
    brief = `Not a washout, but there's rain to watch in the next few days — ` +
      `${pick(['keep a flexible plan', 'have a backup day in mind', "don't lock in outdoor plans without checking back"], seed)} ` +
      `if you're timing something around the weather.`;
  } else if (anyWindySoon) {
    brief = `Skies look mostly cooperative, but winds pick up at times — ` +
      `${pick(['a bit choppier than usual on the water', "noticeable if you're out on the coast", 'worth knowing before a day on the water'], seed)}.`;
  } else {
    brief = `Skies over Vermilion Parish look ${pick(PHRASES[today.bucket], seed)} through the next few days, with nothing significant working its way in. ` +
      `${cap(pick(LAUNCH_GOOD, seed))}.`;
  }

  // ---- Today ----
  const todayLine = `${pick(['Expect', 'Looking at', "It's shaping up to be"], today.date)} a ${pick(PHRASES[today.bucket], today.date)} day, ` +
    `with a high near ${today.hi}°F and a low around ${today.lo}°F. Wind runs up to about ${today.windMax} mph` +
    `${today.rainPct >= 30 ? `, and there's roughly a ${today.rainPct}% chance of rain` : ''}. ` +
    `${cap(['rain', 'storm', 'overcast', 'drizzle'].includes(today.bucket) ? pick(LAUNCH_WATCH, today.date) : pick(LAUNCH_GOOD, today.date))}.`;

  // ---- This weekend ----
  let weekendLine;
  if (weekend.length) {
    const hiAvg = Math.round(weekend.reduce((s, d) => s + d.hi, 0) / weekend.length);
    const loAvg = Math.round(weekend.reduce((s, d) => s + d.lo, 0) / weekend.length);
    const worstBucket = weekend.find(d => ['storm', 'rain'].includes(d.bucket))?.bucket
      || weekend[0].bucket;
    weekendLine = `${weekend.map(d => d.weekday).join(' and ')} ${weekend.length > 1 ? 'look' : 'looks'} ` +
      `${pick(PHRASES[worstBucket], seed + 'wk')}, with highs near ${hiAvg}°F and lows around ${loAvg}°F. ` +
      `${cap(['storm', 'rain'].includes(worstBucket) ? pick(LAUNCH_WATCH, seed + 'wk') : pick(LAUNCH_GOOD, seed + 'wk'))}.`;
  } else {
    weekendLine = `The upcoming weekend is far enough out that the forecast isn't reliable yet — check back closer to the date.`;
  }

  // ---- Looking ahead ----
  let aheadLine;
  const notableAhead = beyond.some(d => ['storm', 'rain'].includes(d.bucket));
  if (notableAhead) {
    aheadLine = `There's a chance of unsettled weather later in the outlook — nothing locked in yet, but we'll update this as it comes into better focus.`;
  } else {
    aheadLine = `Nothing significant on the horizon beyond that at the moment. We'll flag it here quickly if a front, tropical system, or anything else worth planning around comes into view.`;
  }

  return { brief, todayLine, weekendLine, aheadLine };
}

function renderBlock(d, stampText) {
  return `${START_MARK} — a script rewrites everything between these two
             comments each night. Don't hand-edit inside this block; edits will be
             overwritten at the next run. See the SOP for how to pause/edit safely. -->
        <div class="discussion-brief">
          <span class="discussion-tag">In brief</span>
          ${d.brief}
        </div>
        <h3>Today</h3>
        <p class="dim">${d.todayLine}</p>
        <h3>This weekend</h3>
        <p class="dim">${d.weekendLine}</p>
        <h3>Looking ahead</h3>
        <p class="dim">${d.aheadLine}</p>
        ${END_MARK}`;
}

async function main() {
  const daily = await fetchForecast();
  const discussion = buildDiscussion(daily);

  let html = fs.readFileSync(INDEX_PATH, 'utf8');
  const startIdx = html.indexOf(START_MARK);
  const endIdx = html.indexOf(END_MARK);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error('Could not find AUTO-DISCUSSION markers in index.html — was the HTML structure changed?');
  }
  const before = html.slice(0, startIdx);
  const after = html.slice(endIdx + END_MARK.length);
  html = before + renderBlock(discussion) + after;

  const stamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short',
  }) + ' CT';
  html = html.replace(
    /Last updated: [^<]*/,
    `Last updated: ${stamp} — sourced from Open-Meteo, written automatically`
  );

  fs.writeFileSync(INDEX_PATH, html, 'utf8');
  console.log('Weather discussion updated:', stamp);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
