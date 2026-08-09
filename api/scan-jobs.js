// /api/scan-jobs.js
// Fetches REAL live job listings from public job board APIs,
// filters by the user's profile, and saves matches to Supabase.
// No auto-apply bot — returns a real application URL for the user to click.

const GREENHOUSE_COMPANIES = [
  'stripe', 'airbnb', 'coinbase', 'doordash', 'gitlab', 'figma', 'discord',
  'reddit', 'robinhood', 'brex', 'notion', 'plaid', 'flexport'
];

const LEVER_COMPANIES = [
  'netflix', 'shopify', 'palantir', 'canva', 'ramp', 'affirm'
];

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
      source: 'Lever'
    }));
  } catch {
    return [];
  }
}

async function fetchRemoteOKJobs() {
  try {
    const res = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data || [])
      .filter(j => j.position && j.company)
      .slice(0, 30)
      .map(j => ({
        company: j.company,
        role: j.position,
        location: j.location || 'Remote',
        apply_url: j.url || `https://remoteok.com/remote-jobs/${j.id}`,
        source: 'RemoteOK'
      }));
  } catch {
    return [];
  }
}

// Basic relevance scoring: match keywords from user's skills/role against job title
function scoreMatch(job, profile) {
  if (!profile) return 70;
  const skills = (profile.skills || []).map(s => s.toLowerCase());
  const roleType = (profile.role_type || '').toLowerCase();
  const text = (job.role + ' ' + job.company).toLowerCase();

  let score = 60;
  skills.forEach(skill => {
    if (text.includes(skill.toLowerCase())) score += 8;
  });
  if (roleType.includes('intern') && text.includes('intern')) score += 15;
  if (roleType.includes('full') && !text.includes('intern')) score += 10;

  return Math.min(98, score);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, profile, supabaseUrl, supabaseKey } = req.body;

  if (!userId || !supabaseUrl || !supabaseKey) {
    return res.status(400).json({ error: 'Missing userId, supabaseUrl, or supabaseKey' });
  }

  try {
    const [greenhouseResults, leverResults, remoteOkResults] = await Promise.all([
      Promise.all(GREENHOUSE_COMPANIES.map(fetchGreenhouseJobs)).then(r => r.flat()),
      Promise.all(LEVER_COMPANIES.map(fetchLeverJobs)).then(r => r.flat()),
      fetchRemoteOKJobs()
    ]);

    let allJobs = [...greenhouseResults, ...leverResults, ...remoteOkResults];

    if (profile?.role_type?.toLowerCase().includes('intern')) {
      allJobs = allJobs.filter(j =>
        /intern|junior|entry|graduate|new grad/i.test(j.role)
      );
    }

    const scored = allJobs
      .map(j => ({ ...j, match_score: scoreMatch(j, profile) }))
      .sort((a, b) => b.match_score - a.match_score)
      .slice(0, 20);

    if (scored.length === 0) {
      return res.status(200).json({ inserted: 0, message: 'No matching jobs found this scan.' });
    }

    const rows = scored.map(j => ({
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

    const { accessToken } = req.body;
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/user_jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${accessToken || supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(rows)
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return res.status(502).json({ error: 'Supabase insert failed', detail: errText });
    }

    return res.status(200).json({ inserted: rows.length });
  } catch (err) {
    console.error('Scan jobs crash:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
