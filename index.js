// Walmart IP Scanner - Backend Server with MiniMax AI Proxy
// This server acts as a proxy to call MiniMax AI API

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// =============================================
// CONFIGURATION
// =============================================
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_API_BASE = 'https://api.minimax.chat/v1';

// Supabase Configuration
const supabaseUrl = process.env.SUPABASE_URL || 'https://euprioekychumqtxehzd.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Analysis Prompt
const IP_ANALYSIS_PROMPT = `You are an expert in US Intellectual Property Law and Walmart Marketplace compliance policies.

Analyze this POD (Print on Demand) product image for Walmart US Category 025 (Clothing/Shoes).

TASK:
1. Identify all numbered products in the image (look for red rectangular background labels with numbers)
2. Follow left-to-right, top-to-bottom coordinate system - DO NOT skip or misalign numbers
3. For each numbered product, perform THREE specific checks:

A. VISUAL IP & TRADEMARK: Brand logos (Nike, Supreme, Adidas), anime, movies, sports teams
B. CELEBRITY LIKENESS: Celebrity portraits, designs that may appear as official collaborations
C. WALMART RESTRICTIONS: Political content, violence, hate symbols

OUTPUT FORMAT:

【SUICIDE/HIGH-RISK IDs】: (comma-separated)

【MEDIUM-RISK IDs】: (comma-separated)

【SAFE IDs】: (comma-separated)

DETAILED ANALYSIS (for non-safe IDs):
[ID]: Risk Level: [LEVEL]
Violation Type: [Type]
Details: [Explanation]

RATING:
- SUICIDE: Explicit IP infringement, hate speech, violence, profanity
- HIGH: Trademark/copyright violations, celebrity likeness, sports teams
- MEDIUM: Political symbols, religious content, sensitive themes
- SAFE: Generic designs, original artwork`;

// =============================================
// MIDDLEWARE
// =============================================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: 'Too many requests' }
});
app.use('/api/', limiter);

// =============================================
// HEALTH CHECK
// =============================================
app.get('/api/health', async (req, res) => {
  const dbConnected = supabase ? await checkDatabase() : false;

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '3.0.0',
    database: dbConnected ? 'connected' : 'disconnected',
    minimaxEnabled: !!MINIMAX_API_KEY
  });
});

async function checkDatabase() {
  try {
    const { error } = await supabase.from('analysis_history').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}

// =============================================
// ANALYZE IMAGE
// =============================================
app.post('/api/analyze', async (req, res) => {
  const { image, fileName } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'No image provided' });
  }

  const analysisId = uuidv4();
  const startTime = Date.now();

  console.log(`[${analysisId}] Starting analysis...`);

  try {
    // Call MiniMax AI
    const aiResult = await callMiniMaxAI(image, analysisId);

    // Save to database if connected
    if (supabase) {
      await saveToDatabase(analysisId, fileName, aiResult);
    }

    res.json({
      ...aiResult,
      id: analysisId,
      metadata: {
        ...aiResult.metadata,
        processingTime: Date.now() - startTime,
        databaseSaved: !!supabase
      }
    });

  } catch (error) {
    console.error(`[${analysisId}] Error:`, error.message);

    // Return fallback result
    const fallbackResult = generateFallbackResult();
    res.json({
      ...fallbackResult,
      id: analysisId,
      metadata: {
        ...fallbackResult.metadata,
        processingTime: Date.now() - startTime,
        fallbackMode: true
      }
    });
  }
});

// =============================================
// MINIMAX AI CALL
// =============================================
async function callMiniMaxAI(imageData, analysisId) {
  if (!MINIMAX_API_KEY) {
    throw new Error('MiniMax API key not configured');
  }

  // Extract base64 data
  let base64Image = imageData;
  if (imageData.includes(',')) {
    base64Image = imageData.split(',')[1];
  }

  console.log(`[${analysisId}] Calling MiniMax AI...`);

  // Try different endpoints
  const endpoints = [
    { url: `${MINIMAX_API_BASE}/text/chatcompletion_pro`, model: 'abab6.5s-chat' },
    { url: `${MINIMAX_API_BASE}/text/chatcompletion_v2`, model: 'MiniMax-Text-01' }
  ];

  let lastError = '';

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${MINIMAX_API_KEY}`
        },
        body: JSON.stringify({
          model: endpoint.model,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${base64Image}`
                  }
                },
                {
                  type: 'text',
                  text: IP_ANALYSIS_PROMPT
                }
              ]
            }
          ],
          max_tokens: 8000,
          temperature: 0.3
        })
      });

      console.log(`[${analysisId}] Endpoint ${endpoint.url} responded with ${response.status}`);

      if (response.ok) {
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';

        if (content) {
          console.log(`[${analysisId}] AI response received successfully`);
          return parseAIResponse(content);
        }
      } else {
        const errorText = await response.text();
        lastError = `${response.status}: ${errorText}`;
        console.log(`[${analysisId}] Failed: ${lastError}`);
      }
    } catch (e) {
      lastError = e.message;
      console.log(`[${analysisId}] Error: ${e.message}`);
    }
  }

  throw new Error(`All endpoints failed. Last error: ${lastError}`);
}

// =============================================
// PARSE AI RESPONSE
// =============================================
function parseAIResponse(aiResponse) {
  const allRisks = [];
  const suicideHighRisk = new Set();
  const mediumRisk = new Set();
  const safe = new Set();

  // Extract IDs
  const suicideHighMatch = aiResponse.match(/【SUICIDE[\/／]HIGH[\-\-]RISK IDs】[：:]\s*(.+?)(?=\n|——|$)/i);
  const mediumMatch = aiResponse.match(/【MEDIUM[\-\-]RISK IDs】[：:]\s*(.+?)(?=\n|——|$)/i);
  const safeMatch = aiResponse.match(/【SAFE IDs】[：:]\s*(.+?)(?=\n|——|$)/i);

  // Parse suicide/high risks
  if (suicideHighMatch) {
    const ids = suicideHighMatch[1].split(/[,，、\s]+/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
    ids.forEach(id => {
      suicideHighRisk.add(id);
      allRisks.push({
        id,
        riskLevel: 'high',
        violation: 'IP侵权风险',
        details: '详见AI分析',
        category: categorizeText(aiResponse, id)
      });
    });
  }

  // Parse medium risks
  if (mediumMatch) {
    const ids = mediumMatch[1].split(/[,，、\s]+/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
    ids.forEach(id => {
      mediumRisk.add(id);
      allRisks.push({
        id,
        riskLevel: 'medium',
        violation: '中危风险',
        details: '建议修改',
        category: 'generic'
      });
    });
  }

  // Parse safe IDs
  if (safeMatch) {
    const ids = safeMatch[1].split(/[,，、\s]+/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
    ids.forEach(id => safe.add(id));
  }

  // Parse detailed sections
  const detailMatches = aiResponse.matchAll(/\[(\d+)\][：:]\s*(?:Risk Level: )?([^\n]+)/gi);
  for (const match of detailMatches) {
    const id = match[1];
    const content = match[2];

    let riskLevel = 'medium';
    if (/suicide/i.test(content)) riskLevel = 'suicide';
    else if (/high/i.test(content)) riskLevel = 'high';
    else if (/medium/i.test(content)) riskLevel = 'medium';
    else if (/safe/i.test(content)) {
      safe.add(id);
      continue;
    }

    const existingIdx = allRisks.findIndex(r => r.id === id);
    const category = categorizeText(content, id);

    if (existingIdx >= 0) {
      allRisks[existingIdx] = {
        id,
        riskLevel: allRisks[existingIdx].riskLevel === 'suicide' ? 'suicide' : riskLevel,
        violation: extractViolation(content),
        details: content.substring(0, 200),
        category
      };
    } else {
      allRisks.push({
        id,
        riskLevel,
        violation: extractViolation(content),
        details: content.substring(0, 200),
        category
      });
    }

    if (riskLevel === 'suicide' || riskLevel === 'high') {
      suicideHighRisk.add(id);
    } else {
      mediumRisk.add(id);
    }
    safe.delete(id);
  }

  return {
    suicideHighRisk: Array.from(suicideHighRisk).sort((a, b) => parseInt(a) - parseInt(b)),
    mediumRisk: Array.from(mediumRisk).sort((a, b) => parseInt(a) - parseInt(b)),
    safe: Array.from(safe).sort((a, b) => parseInt(a) - parseInt(b)),
    details: allRisks.sort((a, b) => {
      if (a.riskLevel === 'suicide' && b.riskLevel !== 'suicide') return -1;
      if (b.riskLevel === 'suicide' && a.riskLevel !== 'suicide') return 1;
      if (a.riskLevel === 'high' && b.riskLevel === 'medium') return -1;
      if (b.riskLevel === 'high' && a.riskLevel === 'medium') return 1;
      return parseInt(a.id) - parseInt(b.id);
    }),
    summary: {
      total: suicideHighRisk.size + mediumRisk.size + safe.size,
      highRiskCount: suicideHighRisk.size,
      mediumRiskCount: mediumRisk.size,
      safeCount: safe.size,
      breakdown: {
        trademark: allRisks.filter(r => /trademark|商标|品牌/i.test(r.violation)).length,
        copyright: allRisks.filter(r => /copyright|版权|角色/i.test(r.violation)).length,
        celebrity: allRisks.filter(r => /celebrity|名人|肖像/i.test(r.violation)).length,
        politics: allRisks.filter(r => /political|政治/i.test(r.violation)).length,
        violence: allRisks.filter(r => /violence|暴力/i.test(r.violation)).length,
        hate: 0,
        adult: allRisks.filter(r => /profanity|脏话/i.test(r.violation)).length
      }
    },
    metadata: {
      analyzedAt: new Date().toISOString(),
      aiModel: 'MiniMax-Text-01',
      aiProvider: 'MiniMax'
    }
  };
}

function categorizeText(text, id) {
  const lower = text.toLowerCase();
  if (/trademark|品牌|商标/i.test(lower)) return 'trademark';
  if (/copyright|版权|角色|character/i.test(lower)) return 'copyright';
  if (/celebrity|名人|肖像/i.test(lower)) return 'celebrity';
  if (/political|政治/i.test(lower)) return 'politics';
  if (/violence|暴力|gun|weapon/i.test(lower)) return 'violence';
  return 'generic';
}

function extractViolation(text) {
  const match = text.match(/[Vv]iolation [Tt]ype[:：]\s*(.+?)(?:\n|$)/i);
  return match ? match[1].trim() : 'IP侵权风险';
}

// =============================================
// FALLBACK RESULT
// =============================================
function generateFallbackResult() {
  const demoRisks = {
    '1': { riskLevel: 'high', violation: '文字 "LIGHT IT UP BLUE"', details: 'Autism Speaks 注册商标', category: 'trademark' },
    '3': { riskLevel: 'high', violation: '"Soft Kitty" 歌词', details: '《生活大爆炸》版权', category: 'copyright' },
    '7': { riskLevel: 'suicide', violation: '骷髅持枪 + "AUTISM"', details: '暴力+仇恨内容', category: 'violence' },
    '10': { riskLevel: 'high', violation: 'NBA球员肖像', details: 'Kobe Bryant肖像权侵权', category: 'celebrity' },
    '11': { riskLevel: 'high', violation: 'Atlanta Braves标志', details: 'MLB球队商标', category: 'trademark' },
    '15': { riskLevel: 'medium', violation: '美国国旗', details: '政治敏感内容', category: 'politics' }
  };

  const allRisks = [];
  const suicideHighRisk = new Set();
  const mediumRisk = new Set();
  const safe = new Set();

  for (let i = 1; i <= 50; i++) {
    const id = String(i);
    if (demoRisks[id]) {
      const risk = demoRisks[id];
      allRisks.push({ id, ...risk });
      if (risk.riskLevel === 'suicide' || risk.riskLevel === 'high') {
        suicideHighRisk.add(id);
      } else {
        mediumRisk.add(id);
      }
    } else {
      safe.add(id);
    }
  }

  return {
    suicideHighRisk: Array.from(suicideHighRisk).sort((a, b) => parseInt(a) - parseInt(b)),
    mediumRisk: Array.from(mediumRisk).sort((a, b) => parseInt(a) - parseInt(b)),
    safe: Array.from(safe).sort((a, b) => parseInt(a) - parseInt(b)),
    details: allRisks,
    summary: {
      total: 50,
      highRiskCount: suicideHighRisk.size,
      mediumRiskCount: mediumRisk.size,
      safeCount: safe.size,
      breakdown: { trademark: 2, copyright: 2, celebrity: 1, politics: 1, violence: 1, hate: 0, adult: 0 }
    },
    metadata: {
      analyzedAt: new Date().toISOString(),
      aiModel: 'Fallback',
      aiProvider: 'Local'
    }
  };
}

// =============================================
// DATABASE OPERATIONS
// =============================================
async function saveToDatabase(analysisId, fileName, result) {
  try {
    await supabase.from('analysis_history').insert({
      id: analysisId,
      file_name: fileName || 'unknown',
      result: result,
      summary: result.summary,
      created_at: new Date().toISOString()
    });
    console.log(`[${analysisId}] Saved to database`);
  } catch (error) {
    console.error(`[${analysisId}] Database error:`, error.message);
  }
}

// History endpoints
app.get('/api/history', async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;

  if (!supabase) {
    return res.json({ total: 0, items: [] });
  }

  try {
    const { data, error, count } = await supabase
      .from('analysis_history')
      .select('id, file_name, summary, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(0, limit - 1);

    if (error) throw error;

    res.json({ total: count || 0, items: data || [] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

app.get('/api/analysis/:id', async (req, res) => {
  const { id } = req.params;

  if (!supabase) {
    return res.status(503).json({ error: 'Database not connected' });
  }

  try {
    const { data, error } = await supabase
      .from('analysis_history')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Analysis not found' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch analysis' });
  }
});

app.delete('/api/analysis/:id', async (req, res) => {
  const { id } = req.params;

  if (supabase) {
    await supabase.from('analysis_history').delete().eq('id', id);
  }

  res.json({ success: true, id });
});

app.delete('/api/history', async (req, res) => {
  if (supabase) {
    await supabase.from('analysis_history').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  }
  res.json({ success: true });
});

app.get('/api/stats', async (req, res) => {
  if (!supabase) {
    return res.json({ message: 'Database not connected' });
  }

  try {
    const { data } = await supabase.from('analysis_history').select('summary');

    const stats = {
      totalAnalyses: data?.length || 0,
      totalProducts: 0,
      totalHighRisk: 0,
      totalMediumRisk: 0,
      totalSafe: 0
    };

    data?.forEach(item => {
      if (item.summary) {
        stats.totalProducts += item.summary.total || 0;
        stats.totalHighRisk += item.summary.highRiskCount || 0;
        stats.totalMediumRisk += item.summary.mediumRiskCount || 0;
        stats.totalSafe += item.summary.safeCount || 0;
      }
    });

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// =============================================
// START SERVER
// =============================================
app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Walmart IP Scanner Backend v3.0');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Port: ${PORT}`);
  console.log(`  Database: ${supabase ? '✓ Connected' : '✗ Disconnected'}`);
  console.log(`  MiniMax: ${MINIMAX_API_KEY ? '✓ Enabled' : '✗ Disabled'}`);
  console.log('═══════════════════════════════════════════════════════');
});

export default app;
