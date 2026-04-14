require("dotenv").config();

const express = require("express");
const axios = require("axios");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// ===============================
// CONFIG
// ===============================
const CONFIG = {
  port: process.env.PORT || 3000,
  grokApiKey: process.env.GROK_API_KEY,
  grokApiUrl: "https://api.groq.com/openai/v1/chat/completions",
  model: "llama-3.1-8b-instant",
  maxTokens: 300,
  jwtSecret: process.env.JWT_SECRET || "recoverai_secret",
};

// ===============================
// POSTGRESQL
// ===============================
const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || "recoverai",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "",
});

// Initialize tables
async function initDB() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL DEFAULT '',
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('patient','hospital_staff')),
      phone VARCHAR(20),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS symptom_logs (
      id SERIAL PRIMARY KEY,
      patient_id UUID REFERENCES users(id) ON DELETE CASCADE,
      symptoms TEXT NOT NULL,
      severity VARCHAR(20),
      flagged BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_logs (
      id SERIAL PRIMARY KEY,
      patient_id UUID REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(10) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS medications (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      patient_id UUID REFERENCES users(id) ON DELETE CASCADE,
      medication_name VARCHAR(300) NOT NULL,
      dosage VARCHAR(100),
      frequency VARCHAR(100),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recovery_assessments (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      patient_id UUID REFERENCES users(id) ON DELETE CASCADE,
      score INTEGER NOT NULL,
      risk_level VARCHAR(20) NOT NULL,
      answers JSONB NOT NULL,
      surgery_type VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discharge_plans (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      patient_id UUID REFERENCES users(id) ON DELETE CASCADE,
      plan_text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS medication_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      patient_id UUID REFERENCES users(id) ON DELETE CASCADE,
      medication_id UUID REFERENCES medications(id) ON DELETE CASCADE,
      taken BOOLEAN NOT NULL,
      logged_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS patient_profiles (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      primary_diagnosis VARCHAR(500),
      surgery_type VARCHAR(500),
      discharge_date DATE,
      recovery_status VARCHAR(50) DEFAULT 'active',
      readmission_risk VARCHAR(20) DEFAULT 'low'
    )
  `);
  console.log("✅ Database tables ready");
}

initDB().catch((e) => console.error("❌ DB init error:", e.message));

// ===============================
// SYSTEM PROMPT
// ===============================
const SYSTEM_PROMPT = `
You are a compassionate Post-Discharge Recovery Companion chatbot designed to help patients after hospital discharge.

You ONLY assist with:
- Post-surgery and post-hospitalization recovery guidance
- Medication reminders and questions
- Symptom monitoring and when to seek emergency help
- Wound care instructions
- Hospital discharge instructions and follow-up care
- Nutrition and hydration during recovery
- Activity restrictions and safe exercises during recovery
- Emotional support during the recovery journey

If a question is NOT related to any of the above topics, respond strictly with:
"I'm here to support your post-discharge recovery. Please ask me about your symptoms, medications, wound care, or follow-up instructions."

Guidelines:
- Be empathetic, clear, and patient-friendly
- Use simple, non-technical language
- Keep responses concise (3–5 sentences max)
- Always recommend contacting a doctor for serious symptoms like chest pain, difficulty breathing, or signs of infection
- Never diagnose conditions or prescribe medications
`.trim();

// ===============================
// MIDDLEWARE: Auth
// ===============================
function authMiddleware(role) {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "No token provided" });
    try {
      const decoded = jwt.verify(token, CONFIG.jwtSecret);
      if (role && decoded.role !== role) {
        return res.status(403).json({ error: "Access denied" });
      }
      req.user = decoded;
      next();
    } catch {
      res.status(401).json({ error: "Invalid token" });
    }
  };
}

// ===============================
// AUTH ROUTES
// ===============================

// Register
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: "All fields are required" });
  }
  const dbRole = role === "hospital" ? "hospital_staff" : role;
  if (!["patient", "hospital_staff"].includes(dbRole)) {
    return res.status(400).json({ error: "Role must be patient or hospital" });
  }
  const parts = name.trim().split(" ");
  const firstName = parts[0];
  const lastName = parts.slice(1).join(" ") || "-";
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (first_name, last_name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, first_name || ' ' || last_name AS name, email, role",
      [firstName, lastName, email, hash, dbRole]
    );
    const user = result.rows[0];
    if (dbRole === "patient") {
      await pool.query("INSERT INTO patient_profiles (user_id) VALUES ($1)", [user.id]);
    }
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, CONFIG.jwtSecret, { expiresIn: "7d" });
    res.json({ token, user });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Email already registered" });
    console.error("Register error:", e.message);
    res.status(500).json({ error: "Registration failed" });
  }
});

// Login
app.post("/api/auth/login", async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password || !role) {
    return res.status(400).json({ error: "All fields are required" });
  }
  const dbRole = role === "hospital" ? "hospital_staff" : role;
  try {
    const result = await pool.query("SELECT * FROM users WHERE email=$1 AND role=$2", [email, dbRole]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });
    const name = user.first_name + (user.last_name ? " " + user.last_name : "");
    const token = jwt.sign({ id: user.id, name, email: user.email, role: user.role }, CONFIG.jwtSecret, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, name, email: user.email, role: user.role } });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

// ===============================
// CHAT ROUTE (Patient)
// ===============================
app.post("/api/chat", authMiddleware("patient"), async (req, res) => {
  const userMessage = req.body?.message?.trim();
  if (!userMessage) return res.status(400).json({ error: "Message is required" });

  try {
    // Save user message
    await pool.query("INSERT INTO chat_logs (patient_id, role, message) VALUES ($1,'user',$2)", [req.user.id, userMessage]);

    const response = await axios.post(
      CONFIG.grokApiUrl,
      {
        model: CONFIG.model,
        max_tokens: CONFIG.maxTokens,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      },
      {
        headers: { Authorization: `Bearer ${CONFIG.grokApiKey}`, "Content-Type": "application/json" },
        timeout: 15000,
      }
    );

    const reply = response.data?.choices?.[0]?.message?.content;
    if (!reply) return res.status(502).json({ reply: "No response from AI service." });

    // Save bot reply
    await pool.query("INSERT INTO chat_logs (patient_id, role, message) VALUES ($1,'bot',$2)", [req.user.id, reply]);

    res.json({ reply });
  } catch (error) {
    const status = error.response?.status;
    if (status === 401) return res.status(502).json({ reply: "Authentication failed with AI service." });
    if (status === 429) return res.status(429).json({ reply: "Too many requests. Please wait and try again." });
    res.status(500).json({ reply: "Assistant temporarily unavailable." });
  }
});

// ===============================
// PATIENT ROUTES
// ===============================

// Log symptoms
app.post("/api/patient/symptoms", authMiddleware("patient"), async (req, res) => {
  const { symptoms, severity } = req.body;
  if (!symptoms) return res.status(400).json({ error: "Symptoms required" });
  const redFlags = ["chest pain", "difficulty breathing", "high fever", "severe pain", "infection", "bleeding", "unconscious"];
  const flagged = severity === "severe" || redFlags.some((f) => symptoms.toLowerCase().includes(f));
  const result = await pool.query(
    "INSERT INTO symptom_logs (patient_id, symptoms, severity, flagged) VALUES ($1,$2,$3,$4) RETURNING *",
    [req.user.id, symptoms, severity || "mild", flagged]
  );
  res.json({ log: result.rows[0], flagged });
});

// Get own symptom history
app.get("/api/patient/symptoms", authMiddleware("patient"), async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM symptom_logs WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 20",
    [req.user.id]
  );
  res.json({ logs: result.rows });
});

// Get own medications
app.get("/api/patient/medications", authMiddleware("patient"), async (req, res) => {
  const result = await pool.query("SELECT * FROM medications WHERE patient_id=$1 AND is_active=TRUE ORDER BY created_at DESC", [req.user.id]);
  res.json({ medications: result.rows });
});

app.post("/api/patient/medications", authMiddleware("patient"), async (req, res) => {
  const { name, dosage, schedule } = req.body;
  if (!name) return res.status(400).json({ error: "Medication name required" });
  const result = await pool.query(
    "INSERT INTO medications (patient_id, medication_name, dosage, frequency) VALUES ($1,$2,$3,$4) RETURNING *",
    [req.user.id, name, dosage || "", schedule || ""]
  );
  res.json({ medication: result.rows[0] });
});

// Get chat history
app.get("/api/patient/chat-history", authMiddleware("patient"), async (req, res) => {
  const result = await pool.query(
    "SELECT role, message, created_at FROM chat_logs WHERE patient_id=$1 ORDER BY created_at ASC LIMIT 50",
    [req.user.id]
  );
  res.json({ history: result.rows });
});

// ===============================
// HOSPITAL DASHBOARD ROUTES
// ===============================

// All patients
app.get("/api/hospital/patients", authMiddleware("hospital_staff"), async (req, res) => {
  const { status } = req.query;
  let query = `
    SELECT u.id, u.first_name || ' ' || u.last_name AS name, u.email, u.created_at,
      pp.primary_diagnosis, pp.surgery_type, pp.discharge_date, pp.recovery_status, pp.readmission_risk
    FROM users u
    LEFT JOIN patient_profiles pp ON pp.user_id = u.id
    WHERE u.role='patient'`;
  const params = [];
  if (status && status !== 'all') {
    params.push(status);
    query += ` AND pp.recovery_status = $1`;
  }
  query += ` ORDER BY u.created_at DESC`;
  const result = await pool.query(query, params);
  res.json({ patients: result.rows });
});

// Flagged alerts
app.get("/api/hospital/alerts", authMiddleware("hospital_staff"), async (req, res) => {
  const result = await pool.query(`
    SELECT sl.*, u.first_name || ' ' || u.last_name AS patient_name, u.email AS patient_email
    FROM symptom_logs sl
    JOIN users u ON u.id = sl.patient_id::uuid
    WHERE sl.flagged = TRUE
    ORDER BY sl.created_at DESC
    LIMIT 50
  `);
  res.json({ alerts: result.rows });
});

// Patient detail (symptoms + medications)
app.get("/api/hospital/patient/:id", authMiddleware("hospital_staff"), async (req, res) => {
  const { id } = req.params;
  const [userRes, symptomsRes, medsRes] = await Promise.all([
    pool.query(`
      SELECT u.id, u.first_name || ' ' || u.last_name AS name, u.email, u.created_at,
        pp.primary_diagnosis, pp.surgery_type, pp.discharge_date, pp.recovery_status, pp.readmission_risk
      FROM users u
      LEFT JOIN patient_profiles pp ON pp.user_id = u.id
      WHERE u.id=$1 AND u.role='patient'
    `, [id]),
    pool.query("SELECT * FROM symptom_logs WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 20", [id]),
    pool.query("SELECT * FROM medications WHERE patient_id=$1", [id]),
  ]);
  if (!userRes.rows[0]) return res.status(404).json({ error: "Patient not found" });
  res.json({ patient: userRes.rows[0], symptoms: symptomsRes.rows, medications: medsRes.rows });
});

// Delete patient
app.delete('/api/hospital/patient/:id', authMiddleware('hospital_staff'), async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM users WHERE id=$1 AND role=$2', [id, 'patient']);
    res.json({ message: 'Patient deleted' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete patient' });
  }
});

// Edit patient
app.put('/api/hospital/patient/:id', authMiddleware('hospital_staff'), async (req, res) => {
  const { id } = req.params;
  const { name, email, diagnosis, surgeryType, dischargeDate, recoveryStatus } = req.body;
  try {
    if (name || email) {
      const parts = (name || '').trim().split(' ');
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      await pool.query(
        `UPDATE users SET
          first_name = CASE WHEN $1 != '' THEN $1 ELSE first_name END,
          last_name = CASE WHEN $2 != '' THEN $2 ELSE last_name END,
          email = CASE WHEN $3 != '' THEN $3 ELSE email END,
          updated_at = NOW()
        WHERE id=$4`,
        [firstName, lastName, email || '', id]
      );
    }
    // Check if profile exists
    const existing = await pool.query('SELECT id FROM patient_profiles WHERE user_id=$1', [id]);
    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE patient_profiles SET
          primary_diagnosis = CASE WHEN $1 != '' THEN $1 ELSE primary_diagnosis END,
          surgery_type = CASE WHEN $2 != '' THEN $2 ELSE surgery_type END,
          discharge_date = CASE WHEN $3 != '' THEN $3::date ELSE discharge_date END,
          recovery_status = CASE WHEN $4 != '' THEN $4 ELSE recovery_status END,
          updated_at = NOW()
        WHERE user_id=$5`,
        [diagnosis || '', surgeryType || '', dischargeDate || '', recoveryStatus || '', id]
      );
    } else {
      await pool.query(
        `INSERT INTO patient_profiles (user_id, primary_diagnosis, surgery_type, discharge_date, recovery_status)
         VALUES ($1, NULLIF($2,''), NULLIF($3,''), NULLIF($4,'')::date, NULLIF($5,''))`,
        [id, diagnosis || '', surgeryType || '', dischargeDate || '', recoveryStatus || '']
      );
    }
    res.json({ message: 'Patient updated' });
  } catch (e) {
    console.error('Edit patient error:', e.message);
    res.status(500).json({ error: 'Failed to update patient: ' + e.message });
  }
});

// Symptom trend stats (for chart)
app.get("/api/hospital/stats", authMiddleware("hospital_staff"), async (req, res) => {
  const result = await pool.query(`
    SELECT DATE(created_at) AS date, COUNT(*) AS total, SUM(CASE WHEN flagged THEN 1 ELSE 0 END) AS flagged
    FROM symptom_logs
    GROUP BY DATE(created_at)
    ORDER BY date DESC
    LIMIT 14
  `);
  res.json({ stats: result.rows.reverse() });
});

// ===============================
// RECOVERY ASSESSMENT ROUTES
// ===============================

app.post('/api/patient/quiz/generate', authMiddleware('patient'), async (req, res) => {
  const { surgeryType, diagnosis } = req.body;
  if (!surgeryType) return res.status(400).json({ error: 'Surgery type required' });

  const prompt = `You are a medical recovery assessment AI. Generate exactly 8 recovery assessment questions for a patient who had: ${surgeryType}${diagnosis ? ` for ${diagnosis}` : ''}.

Rules:
- Questions must be specific to THIS surgery/condition
- Mix of Yes/No questions
- Cover: pain, wound, mobility, medication, diet, sleep, mood, specific surgery complications
- Be simple and patient-friendly

Respond ONLY with valid JSON array, no extra text:
[
  {"id": 1, "question": "...", "redFlag": true/false, "positiveAnswer": "yes"/"no"},
  ...
]`;

  try {
    const response = await axios.post(
      CONFIG.grokApiUrl,
      { model: CONFIG.model, max_tokens: 800, messages: [{ role: 'user', content: prompt }] },
      { headers: { Authorization: `Bearer ${CONFIG.grokApiKey}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    const raw = response.data?.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!jsonMatch) return res.status(502).json({ error: 'Could not parse questions' });
    const questions = JSON.parse(jsonMatch[0]);
    res.json({ questions, surgeryType, diagnosis });
  } catch (e) {
    console.error('Quiz generate error:', e.message);
    res.status(500).json({ error: 'Failed to generate questions' });
  }
});

app.post('/api/patient/quiz/evaluate', authMiddleware('patient'), async (req, res) => {
  const { surgeryType, diagnosis, questions, answers } = req.body;
  if (!questions || !answers) return res.status(400).json({ error: 'Questions and answers required' });

  const qa = questions.map((q, i) => `Q${i+1}: ${q.question}\nAnswer: ${answers[i] || 'No answer'}`).join('\n\n');

  const prompt = `You are a medical recovery assessment AI. A patient who had ${surgeryType}${diagnosis ? ` for ${diagnosis}` : ''} answered these recovery questions:

${qa}

Analyze their answers and provide:
1. A recovery score from 0-100
2. Risk level: low (71-100), medium (41-70), or high (0-40)
3. 3-4 specific observations about their recovery
4. 2-3 actionable recommendations
5. Whether they need immediate medical attention (true/false)

Respond ONLY with valid JSON, no extra text:
{
  "score": 85,
  "risk_level": "low",
  "observations": ["...", "..."],
  "recommendations": ["...", "..."],
  "urgent": false,
  "summary": "One sentence overall assessment"
}`;

  try {
    const response = await axios.post(
      CONFIG.grokApiUrl,
      { model: CONFIG.model, max_tokens: 600, messages: [{ role: 'user', content: prompt }] },
      { headers: { Authorization: `Bearer ${CONFIG.grokApiKey}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    const raw = response.data?.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ error: 'Could not parse evaluation' });
    const evaluation = JSON.parse(jsonMatch[0]);

    // Save to DB
    await pool.query(
      'INSERT INTO recovery_assessments (patient_id, score, risk_level, answers, surgery_type) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, evaluation.score, evaluation.risk_level, JSON.stringify(answers), surgeryType]
    );

    // Auto-flag if urgent or high risk
    if (evaluation.urgent || evaluation.risk_level === 'high') {
      await pool.query(
        "INSERT INTO symptom_logs (patient_id, symptoms, severity, flagged) VALUES ($1,$2,'severe',TRUE)",
        [req.user.id, `AI Assessment flagged: Score ${evaluation.score}% — ${evaluation.summary}`]
      );
    }

    res.json({ evaluation });
  } catch (e) {
    console.error('Quiz evaluate error:', e.message);
    res.status(500).json({ error: 'Failed to evaluate answers' });
  }
});

app.get('/api/patient/assessments', authMiddleware('patient'), async (req, res) => {
  const result = await pool.query(
    'SELECT id, score, risk_level, surgery_type, created_at FROM recovery_assessments WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 10',
    [req.user.id]
  );
  res.json({ assessments: result.rows });
});

// ===============================
// DISCHARGE PLAN ROUTES
// ===============================

app.post('/api/patient/discharge-plan', authMiddleware('patient'), async (req, res) => {
  const { diagnosis, surgeryType, medications, concerns } = req.body;

  const prompt = `Create a short, clear post-discharge recovery plan. No lengthy paragraphs. Use bullet points only.

Patient: Diagnosis: ${diagnosis || 'Not specified'}, Surgery: ${surgeryType || 'Not specified'}, Medications: ${medications || 'Not specified'}, Concerns: ${concerns || 'None'}

Format exactly as:
Section 1: Medications
- [bullet]

Section 2: Diet
- [bullet]

Section 3: Activity & Rest
- [bullet]

Section 4: Wound Care
- [bullet]

Section 5: Warning Signs
- [bullet]

Section 6: Follow-up
- [bullet]

Max 4 bullets per section. Be direct and simple. No markdown bold except section titles.`;

  try {
    const response = await axios.post(
      CONFIG.grokApiUrl,
      { model: CONFIG.model, max_tokens: 600, messages: [{ role: 'user', content: prompt }] },
      { headers: { Authorization: `Bearer ${CONFIG.grokApiKey}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    const plan = response.data?.choices?.[0]?.message?.content;
    if (!plan) return res.status(502).json({ error: 'Could not generate plan' });

    await pool.query(
      'INSERT INTO discharge_plans (patient_id, plan_text) VALUES ($1,$2)',
      [req.user.id, plan]
    );
    res.json({ plan });
  } catch (e) {
    res.status(500).json({ error: 'Failed to generate discharge plan' });
  }
});

app.get('/api/patient/discharge-plan', authMiddleware('patient'), async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM discharge_plans WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 1',
    [req.user.id]
  );
  res.json({ plan: result.rows[0] || null });
});

// ===============================
// MEDICATION ADHERENCE ROUTES
// ===============================

app.post('/api/patient/medication-log', authMiddleware('patient'), async (req, res) => {
  const { medication_id, taken } = req.body;
  if (!medication_id) return res.status(400).json({ error: 'medication_id required' });
  const result = await pool.query(
    'INSERT INTO medication_logs (patient_id, medication_id, taken) VALUES ($1,$2,$3) RETURNING *',
    [req.user.id, medication_id, taken !== false]
  );
  res.json({ log: result.rows[0] });
});

app.get('/api/patient/medication-adherence', authMiddleware('patient'), async (req, res) => {
  const result = await pool.query(`
    SELECT m.medication_name, m.dosage, m.frequency,
      COUNT(ml.id) AS total_logs,
      SUM(CASE WHEN ml.taken THEN 1 ELSE 0 END) AS taken_count
    FROM medications m
    LEFT JOIN medication_logs ml ON ml.medication_id = m.id
    WHERE m.patient_id=$1 AND m.is_active=TRUE
    GROUP BY m.id, m.medication_name, m.dosage, m.frequency
  `, [req.user.id]);
  res.json({ adherence: result.rows });
});

// ===============================
// PATIENT PROFILE UPDATE
// ===============================

app.put('/api/patient/profile', authMiddleware('patient'), async (req, res) => {
  const { diagnosis, surgeryType, dischargeDate } = req.body;
  await pool.query(`
    INSERT INTO patient_profiles (user_id, primary_diagnosis, surgery_type, discharge_date)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (user_id) DO UPDATE SET
      primary_diagnosis = COALESCE($2, patient_profiles.primary_diagnosis),
      surgery_type = COALESCE($3, patient_profiles.surgery_type),
      discharge_date = COALESCE($4, patient_profiles.discharge_date)
  `, [req.user.id, diagnosis || null, surgeryType || null, dischargeDate || null]);
  res.json({ message: 'Profile updated' });
});

app.get('/api/patient/profile', authMiddleware('patient'), async (req, res) => {
  const result = await pool.query('SELECT * FROM patient_profiles WHERE user_id=$1', [req.user.id]);
  res.json({ profile: result.rows[0] || null });
});

// Hospital: assessment overview
app.get('/api/hospital/assessments', authMiddleware('hospital_staff'), async (req, res) => {
  const result = await pool.query(`
    SELECT ra.score, ra.risk_level, ra.created_at,
      u.first_name || ' ' || u.last_name AS patient_name, u.email
    FROM recovery_assessments ra
    JOIN users u ON u.id = ra.patient_id
    ORDER BY ra.created_at DESC LIMIT 50
  `);
  res.json({ assessments: result.rows });
});

// ===============================
// HEALTH CHECK
// ===============================
app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// ===============================
// START
// ===============================
const server = app.listen(CONFIG.port, () => {
  console.log(`✅ RecoverAI running at http://localhost:${CONFIG.port}`);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`❌ Port ${CONFIG.port} is already in use. Kill the process and restart.`);
    process.exit(1);
  }
});
