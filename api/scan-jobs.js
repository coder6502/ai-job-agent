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
  'delhi', 'gurgaon', 'gurugram', 'noida', 'kolkata', 'ahmedabad'
];

function isIndiaLocation(loc) {
  const l = (loc || '').toLowerCase();
  // Bare "remote" is not enough — that let through "Remote, Canada" etc.
  // Only accept remote if it's explicitly tied to India, or matches a named India city/country.
  if (INDIA_LOCATION_HINTS.some(h => l.includes(h))) return true;
  if (l.includes('remote') && (l.includes('india') || l.includes('apac') || l.trim() === 'remote')) {
    // "remote" alone (no country specified) is ambiguous — treat conservatively as not India
    return false;
  }
  return false;
}

// --- Build a search query from the user's actual profile ---
// Keep this loose: Adzuna/Jooble treat multi-word queries as an AND match,
// so piling on every skill returns zero results. Use just 1-2 top skills.
function buildSearchQuery(profile) {
  const skills = (profile?.skills || []).slice(0, 2);
  const branch = profile?.branch || '';
  if (skills.length) return skills.join(' ');
  if (branch) return branch;
  return 'software engineer';
}

// --- Primary source: Adzuna India, filtered by the user's own skills/role ---
async function fetchAdzunaJobs(profile) {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    console.error('Adzuna credentials missing — set ADZUNA_APP_ID / ADZUNA_APP_KEY in Vercel env vars');
    return [];
  }

  const query = buildSearchQuery(profile);
  const isIntern = (profile?.role_type || '').toLowerCase().includes('intern');

  // Search nationwide first — a narrow city filter (e.g. "Nashik") combined with
  // an AND-matched skill query often returns zero results even when jobs exist in India broadly.
  const params = new URLSearchParams({
    app_id: ADZUNA_APP_ID,
    app_key: ADZUNA_APP_KEY,
    results_per_page: '30',
    what: query,
    ...(isIntern ? { what_phrase: 'intern' } : {})
  });

  try {
    const res = await fetch(`https://api.adzuna.com/v1/api/jobs/in/search/1?${params.toString()}`);
    if (!res.ok) {
      console.error('Adzuna API error:', await res.text());
      return [];
    }
    const data = await res.json();
    console.log(`Adzuna query "${query}" returned ${(data.results || []).length} raw results`);

    let results = data.results || [];

    // Fallback: if the combined-skill query returned nothing, retry with just the single top skill
    if (results.length === 0) {
      const singleSkill = (profile?.skills || [])[0];
      if (singleSkill && singleSkill !== query) {
        const fallbackParams = new URLSearchParams({
          app_id: ADZUNA_APP_ID,
          app_key: ADZUNA_APP_KEY,
          results_per_page: '30',
          what: singleSkill
        });
        const fbRes = await fetch(`https://api.adzuna.com/v1/api/jobs/in/search/1?${fallbackParams.toString()}`);
        if (fbRes.ok) {
          const fbData = await fbRes.json();
          console.log(`Adzuna fallback query "${singleSkill}" returned ${(fbData.results || []).length} raw results`);
          results = fbData.results || [];
        }
      }
    }

    return results.map(j => ({
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

  try {
    const res = await fetch(`https://jooble.org/api/${JOOBLE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: query,
        location: 'India',
        page: '1'
      })
    });
    if (!res.ok) {
      console.error('Jooble API error:', await res.text());
      return [];
    }
    const data = await res.json();
    console.log(`Jooble query "${query}" returned ${(data.jobs || []).length} raw results`);
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
    // content=true pulls the FULL job description, not just the title —
    // without this, skill-matching against Greenhouse jobs was nearly blind.
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${company}/jobs?content=true`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobs || []).map(j => ({
      company: company.charAt(0).toUpperCase() + company.slice(1),
      role: j.title,
      location: j.location?.name || 'Not specified',
      apply_url: j.absolute_url,
      description: (j.content || j.title || '').replace(/<[^>]*>/g, ' '), // strip HTML tags
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

const SENIOR_TITLE_PATTERN = /\b(director|vp|vice president|head of|chief|principal|staff engineer|senior manager|general manager|gm\b)\b/i;
const MID_SENIOR_PATTERN = /\b(lead|manager|senior|sr\.?)\b/i;

// Roughly: is this profile a fresher/early-career candidate?
function isEarlyCareer(profile) {
  const gradYear = parseInt(profile?.grad_year, 10);
  const currentYear = new Date().getFullYear();
  const roleType = (profile?.role_type || '').toLowerCase();
  if (roleType.includes('intern')) return true;
  if (gradYear && gradYear >= currentYear - 1) return true; // graduated last year or graduating soon
  return false;
}

function passesSeniorityFilter(job, profile) {
  if (!isEarlyCareer(profile)) return true; // no restriction for experienced candidates
  const title = job.role.toLowerCase();
  if (SENIOR_TITLE_PATTERN.test(title)) return false; // hard exclude: Director/VP/Chief/Principal/Staff
  if (MID_SENIOR_PATTERN.test(title)) return false; // exclude: Lead/Manager/Senior for freshers
  return true;
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

  // A job with zero skill overlap shouldn't be shown as a "match" at all
  if (matched === 0) return null;

  const skillCoverage = matched / skills.length; // 0..1
  let score = Math.round(skillCoverage * 80); // skills carry most of the weight, no artificial floor

  if (branch && text.includes(branch.split(' ')[0])) score += 8;
  if (roleType.includes('intern') && /intern/.test(text)) score += 12;
  if (roleType.includes('full') && !/intern/.test(text)) score += 8;

  return Math.min(98, Math.max(15, score));
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

    // Filter out senior roles (Director/VP/Lead/Manager) if this looks like a fresher profile —
    // a 90% keyword match on a Director role is still the wrong job.
    allJobs = allJobs.filter(j => passesSeniorityFilter(j, profile));

    // Cross-source dedup: Adzuna/Jooble/ATS often surface the exact same posting
    const seenInBatch = new Set();
    allJobs = allJobs.filter(j => {
      const key = `${j.company}|${j.role}`.toLowerCase().trim();
      if (seenInBatch.has(key)) return false;
      seenInBatch.add(key);
      return true;
    });

    // Score, and only keep genuinely strong matches — low scores don't help anyone get hired
    const MIN_SCORE_THRESHOLD = 40;
    const scored = allJobs
      .map(j => ({ ...j, match_score: scoreMatch(j, profile) }))
      .filter(j => j.match_score !== null && j.match_score >= MIN_SCORE_THRESHOLD)
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, 20);

    if (scored.length === 0) {
      return res.status(200).json({
        inserted: 0,
        message: 'No genuine matches found this scan — try adding more skills or widening your target locations.',
        debug: {
          adzuna_count: adzunaResults.length,
          jooble_count: joobleResults.length,
          greenhouse_lever_india_count: secondary.length,
          scored_count: 0
        }
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
      return res.status(200).json({
        inserted: 0,
        message: 'No new matches — everything found was already in your list.',
        debug: {
          adzuna_count: adzunaResults.length,
          jooble_count: joobleResults.length,
          greenhouse_lever_india_count: secondary.length,
          scored_count: scored.length
        }
      });
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

    return res.status(200).json({
      inserted: newRows.length,
      debug: {
        adzuna_count: adzunaResults.length,
        jooble_count: joobleResults.length,
        greenhouse_lever_india_count: secondary.length,
        scored_count: scored.length
      }
    });
  } catch (err) {
    console.error('Scan jobs crash:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
