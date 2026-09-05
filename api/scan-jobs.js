// /api/scan-jobs.js
// Fetches REAL live India job listings from Adzuna (personalized by profile skills/role),
// with Greenhouse/Lever as a secondary source filtered to India + skill relevance.
// Deduplicates against jobs already saved for this user before inserting.

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID;
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
const JOOBLE_API_KEY = process.env.JOOBLE_API_KEY;

// Kept as a secondary source, but now actually filtered — not dumped in raw.
// Expanded to cover more companies that actually hire heavily in India.
const GREENHOUSE_COMPANIES = [
  'stripe', 'airbnb', 'coinbase', 'doordash', 'gitlab', 'figma', 'discord',
  'reddit', 'robinhood', 'brex', 'notion', 'plaid', 'flexport',
  'freshworks', 'razorpay', 'postman', 'browserstack', 'chargebee',
  'clearbit', 'grafana', 'databricks', 'confluent', 'hashicorp'
];
const LEVER_COMPANIES = [
  'netflix', 'shopify', 'palantir', 'canva', 'ramp', 'affirm',
  'zeta', 'meesho', 'sprinklr', 'delhivery'
];

const INDIA_LOCATION_HINTS = [
  'india', 'bengaluru', 'bangalore', 'hyderabad', 'mumbai', 'pune', 'chennai',
  'delhi', 'gurgaon', 'gurugram', 'noida', 'kolkata', 'ahmedabad', 'remote'
];

function isIndiaLocation(loc) {
  const l = (loc || '').toLowerCase();
  return INDIA_LOCATION_HINTS.some(h => l.includes(h));
}

// --- Build a search query from the user's actual profile ---
function buildSearchQuery(profile) {
  const skills = (profile?.skills || []).slice(0, 5); // top 5 skills, keep query focused
  const branch = profile?.branch || '';
  if (skills.length) return skills.join(' ');
  if (branch) return branch;
  return 'software engineer'; // last-resort fallback, not a silent generic dump
}

// --- Primary source: Adzuna India, filtered by the user's own skills/role ---
async function fetchAdzunaJobs(profile) {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    console.error('Adzuna credentials missing — set ADZUNA_APP_ID / ADZUNA_APP_KEY in Vercel env vars');
    return [];
  }

  const query = buildSearchQuery(profile);
  const isIntern = (profile?.role_type || '').toLowerCase().includes('intern');
  const locationTerm = (profile?.location || '').split(',')[0]?.trim(); // e.g. "Pune" from "Pune, Maharashtra"

  const params = new URLSearchParams({
    app_id: ADZUNA_APP_ID,
    app_key: ADZUNA_APP_KEY,
    results_per_page: '30',
    what: query,
    ...(locationTerm ? { where: locationTerm } : {}),
    ...(isIntern ? { what_phrase: 'intern' } : {})
  });

  try {
    const res = await fetch(`https://api.adzuna.com/v1/api/jobs/in/search/1?${params.toString()}`);
    if (!res.ok) {
      console.error('Adzuna API error:', await res.text());
      return [];
    }
    const data = await res.json();
    return (data.results || []).map(j => ({
      company: j.company?.display_name || 'Unknown',
      role: j.title,
      location: j.location?.display_name || 'India',
      apply_url: j.redirect_url,
      description: j.description || '',
      source: 'Adzuna'
    }));
  } catch (err) {
    console.error('Adzuna fetch failed:', err);
    return [];
  }
}

// --- Secondary primary source: Jooble, aggregates LinkedIn/Naukri/Indeed/company sites ---
async function fetchJoobleJobs(profile) {
  if (!JOOBLE_API_KEY) {
    console.error('Jooble credentials missing — set JOOBLE_API_KEY in Vercel env vars');
    return [];
  }

  const query = buildSearchQuery(profile);
  const locationTerm = (profile?.location || '').split(',')[0]?.trim() || 'India';

  try {
    const res = await fetch(`https://jooble.org/api/${JOOBLE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: query,
        location: locationTerm,
        page: '1'
      })
    });
    if (!res.ok) {
      console.error('Jooble API error:', await res.text());
      return [];
    }
    const data = await res.json();
    return (data.jobs || []).map(j => ({
      company: j.company || 'Unknown',
      role: j.title,
      location: j.location || 'India',
      apply_url: j.link,
      description: j.snippet || '',
      source: 'Jooble'
    }));
  } catch (err) {
    console.error('Jooble fetch failed:', err);
    return [];
  }
}

async function fetchGreenhouseJobs(company) {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${company}/jobs`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobs || []).map(j => ({
      company: company.charAt(0).toUpperCase() + company.slice(1),
      role: j.title,
      location: j.location?.name || 'Not specified',
      apply_url: j.absolute_url,
      description: j.title,
      source: 'Greenhouse'
    }));
  } catch {
    return [];
  }
}

async function fetchLeverJobs(company) {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${company}?mode=json`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data || []).map(j => ({
      company: company.charAt(0).toUpperCase() + company.slice(1),
      role: j.text,
      location: j.categories?.location || 'Not specified',
      apply_url: j.hostedUrl,
      description: j.text,
      source: 'Lever'
    }));
  } catch {
    return [];
  }
}

// --- Real per-job scoring: skill overlap against title+description, not a flat bucket ---
function scoreMatch(job, profile) {
  const skills = (profile?.skills || []).map(s => s.toLowerCase()).filter(Boolean);
  const roleType = (profile?.role_type || '').toLowerCase();
  const branch = (profile?.branch || '').toLowerCase();
  const text = `${job.role} ${job.description || ''}`.toLowerCase();

  if (skills.length === 0) return null; // can't honestly score with no profile data

  let matched = 0;
  skills.forEach(skill => {
    if (text.includes(skill)) matched += 1;
  });

  const skillCoverage = matched / skills.length; // 0..1
  let score = Math.round(skillCoverage * 70); // skills carry most of the weight

  if (branch && text.includes(branch.split(' ')[0])) score += 10;
  if (roleType.includes('intern') && /intern/.test(text)) score += 15;
  if (roleType.includes('full') && !/intern/.test(text)) score += 10;

  // A job with zero skill overlap shouldn't be shown as a "match" at all
  if (matched === 0) return null;

  return Math.min(98, Math.max(30, score));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, profile, supabaseUrl, supabaseKey, accessToken } = req.body;

  if (!userId || !supabaseUrl || !supabaseKey) {
    return res.status(400).json({ error: 'Missing userId, supabaseUrl, or supabaseKey' });
  }
  if (!profile || !(profile.skills || []).length) {
    return res.status(200).json({
      inserted: 0,
      message: 'Add skills to your profile first — matching needs at least one skill to work from.'
    });
  }

  try {
    const [adzunaResults, joobleResults, greenhouseResults, leverResults] = await Promise.all([
      fetchAdzunaJobs(profile),
      fetchJoobleJobs(profile),
      Promise.all(GREENHOUSE_COMPANIES.map(fetchGreenhouseJobs)).then(r => r.flat()),
      Promise.all(LEVER_COMPANIES.map(fetchLeverJobs)).then(r => r.flat())
    ]);

    // Greenhouse/Lever have no location filter built in — enforce India/remote here
    const secondary = [...greenhouseResults, ...leverResults].filter(j => isIndiaLocation(j.location));

    let allJobs = [...adzunaResults, ...joobleResults, ...secondary];

    const isIntern = (profile?.role_type || '').toLowerCase().includes('intern');
    if (isIntern) {
      allJobs = allJobs.filter(j => /intern|junior|entry|graduate|new grad/i.test(j.role));
    }

    // Cross-source dedup: Adzuna/Jooble/ATS often surface the exact same posting
    const seenInBatch = new Set();
    allJobs = allJobs.filter(j => {
      const key = `${j.company}|${j.role}`.toLowerCase().trim();
      if (seenInBatch.has(key)) return false;
      seenInBatch.add(key);
      return true;
    });

    // Score, and drop anything that isn't a genuine skill match
    const scored = allJobs
      .map(j => ({ ...j, match_score: scoreMatch(j, profile) }))
      .filter(j => j.match_score !== null)
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, 20);

    if (scored.length === 0) {
      return res.status(200).json({
        inserted: 0,
        message: 'No genuine matches found this scan — try adding more skills or widening your target locations.'
      });
    }

    // --- Deduplicate against jobs already saved for this user ---
    const existingRes = await fetch(
      `${supabaseUrl}/rest/v1/user_jobs?user_id=eq.${userId}&select=company,role,apply_url`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${accessToken || supabaseKey}`
        }
      }
    );
    const existing = existingRes.ok ? await existingRes.json() : [];
    const existingKeys = new Set(
      existing.map(e => (e.apply_url || `${e.company}|${e.role}`).toLowerCase())
    );

    const newRows = scored
      .filter(j => !existingKeys.has((j.apply_url || `${j.company}|${j.role}`).toLowerCase()))
      .map(j => ({
        user_id: userId,
        company: j.company,
        role: j.role,
        location: j.location,
        type: /intern/i.test(j.role) ? 'Internship' : 'Full-time',
        match_score: j.match_score,
        status: 'Pending',
        apply_url: j.apply_url,
        source: j.source
      }));

    if (newRows.length === 0) {
      return res.status(200).json({ inserted: 0, message: 'No new matches — everything found was already in your list.' });
    }

    const insertRes = await fetch(`${supabaseUrl}/rest/v1/user_jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${accessToken || supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(newRows)
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return res.status(502).json({ error: 'Supabase insert failed', detail: errText });
    }

    return res.status(200).json({ inserted: newRows.length });
  } catch (err) {
    console.error('Scan jobs crash:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
