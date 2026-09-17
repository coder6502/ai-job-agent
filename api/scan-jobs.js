// /api/scan-jobs.js
// Fetches REAL live India job listings from Adzuna (personalized by profile skills/role),
// with Greenhouse/Lever as a secondary source filtered to India + skill relevance.
// Deduplicates against jobs already saved for this user before inserting.

export const config = {
  maxDuration: 30 // give the multi-query search + link-liveness check enough headroom
};

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

// Greenhouse/Lever list only tech companies — running them for a non-tech profile
// (mechanical, commerce, nursing, sales, etc.) just adds irrelevant noise and wastes time.
// Adzuna/Jooble remain the real general-purpose sources for every field.
const TECH_SIGNAL_PATTERN = /computer|information technology|\bit\b|software|electronics|programming|developer|engineer(?!ing\s*\(mechanical|ing\s*\(civil)|data science|data analytics|data engineering|web develop/i;

function isTechProfile(profile) {
  const branch = (profile?.branch || '').toLowerCase();
  const degree = (profile?.degree || '').toLowerCase();
  const skills = (profile?.skills || []).join(' ').toLowerCase();
  return TECH_SIGNAL_PATTERN.test(branch) || TECH_SIGNAL_PATTERN.test(degree) || TECH_SIGNAL_PATTERN.test(skills);
}

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

// Broad domain names don't appear literally in job descriptions ("Data Analytics" as a phrase
// is rare even in genuine data analytics postings) — expand them into the real technical terms
// recruiters and job descriptions actually use, for both searching and scoring.
const DOMAIN_KEYWORD_MAP = {
  'web developer': ['html', 'css', 'javascript', 'react', 'node.js', 'frontend', 'backend'],
  'web development': ['html', 'css', 'javascript', 'react', 'node.js', 'frontend', 'backend'],
  'data analytics': ['sql', 'excel', 'power bi', 'tableau', 'data analysis', 'pandas'],
  'data analyst': ['sql', 'excel', 'power bi', 'tableau', 'data analysis', 'pandas'],
  'data science': ['python', 'machine learning', 'pandas', 'numpy', 'scikit-learn', 'statistics'],
  'data engineering': ['sql', 'etl', 'spark', 'airflow', 'python', 'data pipeline'],
  'data engineer': ['sql', 'etl', 'spark', 'airflow', 'python', 'data pipeline']
};

// Fuzzy-match a tag against known domain keys — handles typos like "Web Deveploper" / "Data Enginerring"
// by checking if enough characters overlap in sequence (cheap substitute for edit-distance).
function fuzzyMatchDomainKey(tag) {
  const words = tag.split(/\s+/);
  for (const key of Object.keys(DOMAIN_KEYWORD_MAP)) {
    const keyWords = key.split(/\s+/);
    if (keyWords.length !== words.length) continue;
    const closeEnough = keyWords.every((kw, i) => {
      const w = words[i] || '';
      if (kw === w) return true;
      // Same starting 4 chars is a decent typo-tolerant heuristic for these short domain words
      return kw.length >= 4 && w.length >= 4 && kw.slice(0, 4) === w.slice(0, 4);
    });
    if (closeEnough) return key;
  }
  return null;
}

// Expand a raw skills list into a richer set of matchable keywords
function expandSkillKeywords(skills) {
  const expanded = new Set();
  (skills || []).forEach(s => {
    const lower = s.toLowerCase().trim();
    expanded.add(lower);
    if (DOMAIN_KEYWORD_MAP[lower]) {
      DOMAIN_KEYWORD_MAP[lower].forEach(k => expanded.add(k));
    } else {
      const fuzzyKey = fuzzyMatchDomainKey(lower);
      if (fuzzyKey) DOMAIN_KEYWORD_MAP[fuzzyKey].forEach(k => expanded.add(k));
    }
  });
  return Array.from(expanded);
}

// --- Build search queries from the user's actual profile ---
// Returns an ARRAY of queries — one per distinct skill/domain — so a multi-domain
// profile (e.g. Web Dev + Data Science) searches each path properly instead of
// mashing everything into one over-restrictive AND query.
function buildSearchQueries(profile) {
  const rawSkills = (profile?.skills || []).slice(0, 4);
  const branch = (profile?.branch || '').trim();

  if (rawSkills.length === 0) {
    return [branch || 'entry level'];
  }

  const queries = rawSkills.map(skill => {
    const lower = skill.toLowerCase().trim();
    if (DOMAIN_KEYWORD_MAP[lower]) {
      return DOMAIN_KEYWORD_MAP[lower].slice(0, 2).join(' ');
    }
    const fuzzyKey = fuzzyMatchDomainKey(lower);
    if (fuzzyKey) {
      return DOMAIN_KEYWORD_MAP[fuzzyKey].slice(0, 2).join(' ');
    }
    return skill; // works as-is for any field — nursing, mechanical, commerce, sales, etc.
  });

  // Branch/field of study is often the strongest search signal for non-tech qualifications
  // (e.g. "Mechanical Engineering", "B.Com", "Nursing") — include it as its own query.
  if (branch) queries.push(branch);

  // Dedupe and cap at 3 — more than that risks hitting Adzuna/Jooble's free-tier rate limits.
  return Array.from(new Set(queries)).slice(0, 3);
}

// --- Primary source: Adzuna India, filtered by the user's own skills/role ---
async function fetchAdzunaJobs(profile) {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    console.error('Adzuna credentials missing — set ADZUNA_APP_ID / ADZUNA_APP_KEY in Vercel env vars');
    return [];
  }

  const queries = buildSearchQueries(profile);
  const isIntern = (profile?.role_type || '').toLowerCase().includes('intern');

  const runQuery = async (query) => {
    const params = new URLSearchParams({
      app_id: ADZUNA_APP_ID,
      app_key: ADZUNA_APP_KEY,
      results_per_page: '20',
      what: query,
      ...(isIntern ? { what_phrase: 'intern' } : {})
    });
    try {
      const res = await fetch(`https://api.adzuna.com/v1/api/jobs/in/search/1?${params.toString()}`);
      if (!res.ok) {
        console.error(`Adzuna API error for "${query}":`, await res.text());
        return [];
      }
      const data = await res.json();
      console.log(`Adzuna query "${query}" returned ${(data.results || []).length} raw results`);
      return (data.results || []).map(j => ({
        company: j.company?.display_name || 'Unknown',
        role: j.title,
        location: j.location?.display_name || 'India',
        apply_url: j.redirect_url,
        description: j.description || '',
        source: 'Adzuna'
      }));
    } catch (err) {
      console.error(`Adzuna fetch failed for "${query}":`, err);
      return [];
    }
  };

  const allResults = await Promise.all(queries.map(runQuery));
  return allResults.flat();
}

// --- Secondary primary source: Jooble, aggregates LinkedIn/Naukri/Indeed/company sites ---
async function fetchJoobleJobs(profile) {
  if (!JOOBLE_API_KEY) {
    console.error('Jooble credentials missing — set JOOBLE_API_KEY in Vercel env vars');
    return [];
  }

  const queries = buildSearchQueries(profile);

  const runQuery = async (query) => {
    try {
      const res = await fetch(`https://jooble.org/api/${JOOBLE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: query, location: 'India', page: '1' })
      });
      if (!res.ok) {
        console.error(`Jooble API error for "${query}":`, await res.text());
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
      console.error(`Jooble fetch failed for "${query}":`, err);
      return [];
    }
  };

  const allResults = await Promise.all(queries.map(runQuery));
  return allResults.flat();
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

const SENIOR_TITLE_PATTERN = /\b(director|vp|vice president|head of|chief|principal|staff|senior manager|general manager|gm\b|solutions architect|solution architect|architect)\b/i;
const MID_SENIOR_PATTERN = /\b(lead|manager|senior|sr\.?|(sde|swe|sde-|engineer)\s*(ii|iii|iv|v)\b|\b(ii|iii|iv)\s*$)/i;
const EXPERIENCE_PATTERN = /(\d+)\s*\+?\s*(?:to\s*\d+\s*)?years?\s*(?:of)?\s*experience/i;

// Greenhouse/Lever list companies wholesale — including non-engineering departments
// (Finance, Legal, HR, Operations) that have nothing to do with a tech-track profile.
const NON_TECH_DEPARTMENT_PATTERN = /\b(financial analyst|legal entity|legal counsel|controller|accounting|accountant|tax\b|payroll|recruiter|recruiting|talent acquisition|hr business partner|human resources|contracting operations|procurement|compliance officer|paralegal|litigation)\b/i;

function passesNonTechDepartmentFilter(job, profile) {
  if (!isTechProfile(profile)) return true; // only applies when we expect engineering/tech roles
  return !NON_TECH_DEPARTMENT_PATTERN.test(job.role.toLowerCase());
}

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

// Exclude jobs whose description explicitly demands more years than a fresher realistically has
function passesExperienceFilter(job, profile) {
  if (!isEarlyCareer(profile)) return true; // no restriction for experienced candidates
  const text = `${job.role} ${job.description || ''}`;
  const match = text.match(EXPERIENCE_PATTERN);
  if (!match) return true; // no explicit requirement stated — don't penalize
  const requiredYears = parseInt(match[1], 10);
  return requiredYears <= 1; // freshers/interns realistically qualify for 0-1 year requirements
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- AI-powered scoring: ask Gemini to genuinely assess fit, not just count keyword hits ---
// Sends the whole shortlist in ONE call (not one call per job) to stay fast and cheap.
async function scoreWithAI(jobs, profile) {
  if (!GEMINI_API_KEY || jobs.length === 0) return null; // caller falls back to keyword scoring

  const profileSummary = `
Skills: ${(profile?.skills || []).join(', ') || 'none listed'}
Branch/Field: ${profile?.branch || 'not specified'}
Degree: ${profile?.degree || 'not specified'}
Graduation year: ${profile?.grad_year || 'not specified'}
Looking for: ${profile?.role_type || 'not specified'}
Current location: ${profile?.location || 'not specified'}
Work mode preference: ${profile?.work_mode || 'not specified'}
Resume summary: ${profile?.summary || 'not provided'}
`.trim();

  const jobList = jobs.map((j, i) => `
[${i}] Company: ${j.company}
Title: ${j.role}
Location: ${j.location}
Description excerpt: ${(j.description || '').slice(0, 500)}
`).join('\n');

  const prompt = `You are an expert recruiter across ALL industries (not just tech) — the candidate below may be in engineering, commerce, healthcare, sales, or any other field. Score how well this candidate genuinely fits EACH job below, from 0-100, based on real qualification fit. Weigh ALL of the following, not just isolated keyword overlap:
1. Skills/qualifications actually required vs what the candidate has
2. Experience level required vs the candidate's career stage (a "III"/"Senior"/"Staff" title needs more experience than a fresher has)
3. Whether the job's department/function genuinely matches the candidate's field (e.g. a Finance or Legal role is a bad fit for an engineering candidate even at a tech company, and vice versa)
4. Location fit: if the job's location is far from the candidate's current location and their work-mode preference isn't remote/flexible, penalize the score — a strong skills match in a city they can't realistically relocate to or commute to is NOT a perfect match
Be honest and critical: a job that's a poor fit on ANY of these dimensions should score low (below 40), even if some words overlap. Only a job that's genuinely realistic across skills, experience, department, AND location should score high (70+).

CANDIDATE PROFILE:
${profileSummary}

JOBS:
${jobList}

Respond with ONLY a JSON array, no other text, in this exact format. Keep "reason" under 12 words.
[{"index": 0, "score": 72, "reason": "short reason"}, {"index": 1, "score": 35, "reason": "short reason"}]`;

  try {
    // Retry on transient overload (503) — this is Google's servers being busy, not a config error
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 3000, temperature: 0.2 }
            })
          }
        );
        if (res.status === 503) {
          lastError = await res.text();
          console.error(`Gemini overloaded (attempt ${attempt + 1}/3):`, lastError);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // 1s, 2s backoff
          continue;
        }
        if (res.status === 429) {
          // Daily/rate quota exhausted — retrying won't help within our time budget, fail fast
          lastError = await res.text();
          console.error('Gemini quota exhausted, not retrying:', lastError);
          return null;
        }
        if (!res.ok) {
          console.error('Gemini scoring API error:', await res.text());
          return null;
        }
        const data = await res.json();
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        let cleaned = raw.replace(/```json|```/g, '').trim();
        // Defensive: if the response got cut off mid-array, salvage whatever complete objects exist
        try {
          return JSON.parse(cleaned);
        } catch (parseErr) {
          const lastCompleteObj = cleaned.lastIndexOf('}');
          if (lastCompleteObj > 0) {
            const salvaged = cleaned.slice(0, lastCompleteObj + 1) + ']';
            const openBracket = salvaged.indexOf('[');
            if (openBracket >= 0) {
              try {
                return JSON.parse(salvaged.slice(openBracket));
              } catch {
                // fall through to attempt-level retry below
              }
            }
          }
          throw parseErr;
        }
      } catch (err) {
        lastError = err;
        console.error(`Gemini attempt ${attempt + 1}/3 failed:`, err);
      }
    }
    console.error('Gemini scoring failed after 3 attempts:', lastError);
    return null;
  } catch (err) {
    console.error('Gemini scoring failed:', err);
    return null;
  }
}
// Only run on the final shortlist (not the full raw pool) to stay within serverless time limits.
async function filterLiveLinks(jobs) {
  const checks = jobs.map(async (job) => {
    if (!job.apply_url) return { job, alive: true }; // no URL to check, don't block it
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(job.apply_url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
      clearTimeout(timeout);
      return { job, alive: res.status < 400 };
    } catch {
      // Some job boards block HEAD requests entirely — don't punish those, only confirmed 404s
      return { job, alive: true };
    }
  });
  const results = await Promise.all(checks);
  return results.filter(r => r.alive).map(r => r.job);
}
// Score how well a job's location fits the user's stated location/work-mode preference.
// Returns a signed adjustment — real distance mismatch should lower an otherwise-good match,
// not just be ignored the way it was before.
function locationFitAdjustment(job, profile) {
  const workMode = (profile?.work_mode || '').toLowerCase();
  const userCity = (profile?.location || '').split(',')[0]?.trim().toLowerCase();
  const jobLoc = (job.location || '').toLowerCase();

  if (!userCity) return 0; // no stated location — can't judge proximity, stay neutral
  if (workMode.includes('any')) return 0; // user explicitly said location doesn't matter

  const jobIsRemote = /remote/.test(jobLoc);
  if (jobIsRemote && (workMode.includes('remote') || workMode.includes('any') || !workMode)) return 6; // good fit
  if (jobLoc.includes(userCity)) return 10; // job is in the user's own city — strong real fit

  // Job is in a different, specific city and the user didn't say remote/any — real mismatch
  if (workMode.includes('on-site') || workMode.includes('hybrid')) return -15;
  return -8; // milder penalty when work-mode preference wasn't specified
}

function scoreMatch(job, profile) {
  const skills = expandSkillKeywords((profile?.skills || []).filter(Boolean)); // "Data Analytics" → sql, excel, power bi, etc.
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
  score += locationFitAdjustment(job, profile);

  return Math.min(98, Math.max(10, score));
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

  const runTechSources = isTechProfile(profile);

  try {
    const [adzunaResults, joobleResults, greenhouseResults, leverResults] = await Promise.all([
      fetchAdzunaJobs(profile),
      fetchJoobleJobs(profile),
      runTechSources ? Promise.all(GREENHOUSE_COMPANIES.map(fetchGreenhouseJobs)).then(r => r.flat()) : Promise.resolve([]),
      runTechSources ? Promise.all(LEVER_COMPANIES.map(fetchLeverJobs)).then(r => r.flat()) : Promise.resolve([])
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

    // Filter out jobs explicitly demanding years of experience a fresher doesn't have,
    // even if the title itself looked entry-level.
    allJobs = allJobs.filter(j => passesExperienceFilter(j, profile));

    // Filter out Finance/Legal/HR/Operations postings that leaked in from a tech company's
    // full job board — irrelevant to a tech-track candidate regardless of keyword overlap.
    allJobs = allJobs.filter(j => passesNonTechDepartmentFilter(j, profile));

    // Cross-source dedup: Adzuna/Jooble/ATS often surface the exact same posting
    const seenInBatch = new Set();
    allJobs = allJobs.filter(j => {
      const key = `${j.company}|${j.role}`.toLowerCase().trim();
      if (seenInBatch.has(key)) return false;
      seenInBatch.add(key);
      return true;
    });

    // First pass: cheap keyword pre-filter to cut the pool down to a manageable size
    // before spending an AI call on genuine qualification assessment.
    // IMPORTANT: don't just take a global top-N by keyword_score — Greenhouse jobs have
    // full-text descriptions (content=true) and rack up far more keyword hits than Jooble/
    // Adzuna's short snippets, so a single global ranking lets ATS postings crowd out every
    // other source entirely. Cap per-source, then merge, so all sources get a fair shot.
    const scoredAll = allJobs
      .map(j => ({ ...j, keyword_score: scoreMatch(j, profile) }))
      .filter(j => j.keyword_score !== null);

    const bySource = {};
    scoredAll.forEach(j => {
      const src = j.source || 'Other';
      if (!bySource[src]) bySource[src] = [];
      bySource[src].push(j);
    });
    Object.keys(bySource).forEach(src => {
      bySource[src].sort((a, b) => b.keyword_score - a.keyword_score);
    });

    const PER_SOURCE_CAP = 6; // e.g. up to 6 from Adzuna, 6 from Jooble, 6 from ATS
    const prefiltered = Object.values(bySource)
      .flatMap(list => list.slice(0, PER_SOURCE_CAP))
      .sort((a, b) => b.keyword_score - a.keyword_score)
      .slice(0, 20); // overall cap to keep the AI call fast

    if (prefiltered.length === 0) {
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

    // Second pass: real AI assessment of genuine fit (skills, experience, qualifications)
    const aiResults = await scoreWithAI(prefiltered, profile);

    const AI_SCORE_THRESHOLD = 40;
    const FALLBACK_SCORE_THRESHOLD = 15; // matches scoreMatch's floor — a single keyword hit from a short Jooble snippet is still a real signal worth surfacing
    let scored;
    if (aiResults && Array.isArray(aiResults)) {
      scored = aiResults
        .map(r => {
          const job = prefiltered[r.index];
          if (!job) return null;
          return { ...job, match_score: Math.round(r.score), match_reason: r.reason };
        })
        .filter(j => j !== null && j.match_score >= AI_SCORE_THRESHOLD)
        .sort((a, b) => b.match_score - a.match_score)
        .slice(0, 20);
    } else {
      // Fallback: AI unavailable or failed — use the keyword score already computed
      scored = prefiltered
        .filter(j => j.keyword_score >= FALLBACK_SCORE_THRESHOLD)
        .map(j => ({ ...j, match_score: j.keyword_score }))
        .sort((a, b) => b.match_score - a.match_score)
        .slice(0, 20);
    }

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

    // Drop dead/expired links before showing anyone a job they can't actually apply to
    const liveScored = await filterLiveLinks(scored);

    if (liveScored.length === 0) {
      return res.status(200).json({
        inserted: 0,
        message: 'Found matches but all their application links were expired — try scanning again shortly.',
        debug: {
          adzuna_count: adzunaResults.length,
          jooble_count: joobleResults.length,
          greenhouse_lever_india_count: secondary.length,
          scored_count: scored.length
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

    const newRows = liveScored
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
        scored_count: scored.length,
        ai_scoring_used: !!(aiResults && Array.isArray(aiResults))
      }
    });
  } catch (err) {
    console.error('Scan jobs crash:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
