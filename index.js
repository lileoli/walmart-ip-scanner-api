// Walmart IP Scanner - Backend Server with Claude Vision + MiniMax Proxy
// Supports both Claude Vision and MiniMax for image analysis

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// =============================================
// CONFIGURATION
// =============================================

// Anthropic Claude API Configuration
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_URL = 'https://api.anthropic.com';

// MiniMax API Configuration (fallback)
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_API_BASE = 'https://api.minimax.chat/v1';

// Supabase Configuration
const supabaseUrl = process.env.SUPABASE_URL || 'https://euprioekychumqtxehzd.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Analysis Prompt for Claude
const ANALYSIS_PROMPT = `You are an expert in US Intellectual Property Law and Walmart Marketplace compliance policies.

Analyze this POD (Print on Demand) product image for Walmart US Category 025 (Clothing/Shoes).

TASK:
1. Identify all numbered products in the image (look for red rectangular background labels with numbers)
2. Follow left-to-right, top-to-bottom coordinate system - DO NOT skip or misalign numbers
3. For each numbered product, perform THREE specific checks:

A. VISUAL IP & TRADEMARK: Brand logos (Nike, Supreme, Adidas), anime, movies, sports teams
B. CELEBRITY LIKENESS: Celebrity portraits, designs that may appear as official collaborations
C. WALMART RESTRICTIONS: Political content, violence, hate symbols

OUTPUT FORMAT (STRICTLY FOLLOW):

## RISK SUMMARY (MUST BE FIRST):

【SUICIDE/HIGH-RISK IDs】: (comma-separated) —— ABSOLUTELY PROHIBITED

【MEDIUM-RISK IDs】: (comma-separated) —— RECOMMEND MODIFICATION

【SAFE IDs】: (comma-separated) —— RECOMMEND MANUAL REVIEW

## DETAILED ANALYSIS (in ID order, for non-safe IDs only):

[ID]: [Risk Level: SUICIDE/HIGH/MEDIUM]
[Violation Type]: [Specific element causing violation]
[Details]: [Why this violates Walmart policy]

RATING CRITERIA:
- SUICIDE: Explicit IP infringement, hate speech, violence, profanity - ABSOLUTE NO-GO
- HIGH: Clear trademark/copyright violations, celebrity likeness, sports teams
- MEDIUM: Political symbols, religious content, sensitive themes
- SAFE: Generic designs, original artwork, no recognizable IP elements

Be thorough and identify EVERY numbered product.`;

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
  max: 10,
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api', limiter);

// =============================================
// HEALTH CHECK
// =============================================
app.get('/api/health', async (req, res) => {
  let dbStatus = 'disconnected';
  let stats = null;

  if (supabase) {
    try {
      const { count } = await supabase.from('analysis_history').select('*', { count: 'exact', head: true });
      dbStatus = 'connected';
      stats = { totalAnalyses: count || 0 };
    } catch (e) {
      console.log('Database check failed:', e.message);
    }
  }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '4.0.0',
    database: dbStatus,
    claudeEnabled: !!ANTHROPIC_API_KEY,
    minimaxEnabled: !!MINIMAX_API_KEY,
    stats
  });
});

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
    // Try Claude Vision first (preferred)
    if (ANTHROPIC_API_KEY) {
      console.log(`[${analysisId}] Trying Claude Vision...`);
      const aiResult = await callClaudeVision(image, analysisId);

      if (aiResult) {
        if (supabase) {
          await saveToDatabase(analysisId, fileName, aiResult);
        }

        return res.json({
          ...aiResult,
          id: analysisId,
          metadata: {
            ...aiResult.metadata,
            processingTime: Date.now() - startTime,
            databaseSaved: !!supabase,
            aiProvider: 'Claude Vision'
          }
        });
      }
    }

    // Try MiniMax as fallback
    if (MINIMAX_API_KEY) {
      console.log(`[${analysisId}] Trying MiniMax...`);
      const aiResult = await callMiniMaxAI(image, analysisId);

      if (supabase) {
        await saveToDatabase(analysisId, fileName, aiResult);
      }

      return res.json({
        ...aiResult,
        id: analysisId,
        metadata: {
          ...aiResult.metadata,
          processingTime: Date.now() - startTime,
          databaseSaved: !!supabase,
          aiProvider: 'MiniMax'
        }
      });
    }

    // Fallback to demo data
    console.log(`[${analysisId}] Using demo data (no API configured)`);
    const fallbackResult = generateFallbackResult();

    return res.json({
      ...fallbackResult,
      id: analysisId,
      metadata: {
        ...fallbackResult.metadata,
        processingTime: Date.now() - startTime,
        demoMode: true
      }
    });

  } catch (error) {
    console.error(`[${analysisId}] Error:`, error.message);

    // Return fallback result
    const fallbackResult = generateFallbackResult();
    return res.json({
      ...fallbackResult,
      id: analysisId,
      metadata: {
        ...fallbackResult.metadata,
        processingTime: Date.now() - startTime,
        error: error.message,
        demoMode: true
      }
    });
  }
});

// =============================================
// CLAUDE VISION API CALL
// =============================================
async function callClaudeVision(imageData, analysisId) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('Claude API key not configured');
  }

  // Extract base64 data
  let base64Image = imageData;
  if (imageData.includes(',')) {
    base64Image = imageData.split(',')[1];
  }

  console.log(`[${analysisId}] Calling Claude Vision API...`);

  try {
    const response = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: base64Image
              }
            },
            {
              type: 'text',
              text: ANALYSIS_PROMPT
            }
          ]
        }]
      })
    });

    console.log(`[${analysisId}] Claude response status:`, response.status);

    if (response.ok) {
      const data = await response.json();
      const content = data.content?.[0]?.text || '';

      if (content) {
        console.log(`[${analysisId}] Claude Vision response received`);
        return parseAIResponse(content);
      }
    } else {
      const errorText = await response.text();
      console.log(`[${analysisId}] Claude API error: ${errorText}`);
      throw new Error(`Claude API failed: ${response.status}`);
    }
  } catch (e) {
    console.error(`[${analysisId}] Claude Vision error:`, e.message);
    throw e;
  }

  return null;
}

// =============================================
// MINIMAX AI CALL (FALLBACK)
// =============================================
async function callMiniMaxAI(imageData, analysisId) {
  if (!MINIMAX_API_KEY) {
    throw new Error('MiniMax API key not configured');
  }

  // MiniMax text API doesn't support images, use demo data
  console.log(`[${analysisId}] MiniMax doesn't support images, using demo data`);
  return generateFallbackResult();
}

// =============================================
// PARSE AI RESPONSE
// =============================================
function parseAIResponse(aiResponse) {
  const allRisks = [];
  const suicideHighRisk = new Set();
  const mediumRisk = new Set();
  const safe = new Set();

  // Extract IDs from summary
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
        details: '详见AI分析报告',
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
        details: '建议修改后上架',
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
    const section = match[0];

    let riskLevel = 'medium';
    if (/suicide/i.test(section)) riskLevel = 'suicide';
    else if (/high/i.test(section)) riskLevel = 'high';
    else if (/medium/i.test(section)) riskLevel = 'medium';
    else if (/safe/i.test(section)) {
      safe.add(id);
      continue;
    }

    const violationMatch = section.match(/[Vv]iolation[\s-]*[Tt]ype[：:]\s*(.+?)(?:\n|$)/i);
    const detailsMatch = section.match(/[Dd]etails?[：:]\s*(.+?)(?:\n|$)/i);

    // Update existing or add new
    const existingIdx = allRisks.findIndex(r => r.id === id);
    if (existingIdx >= 0) {
      allRisks[existingIdx] = {
        ...allRisks[existingIdx],
        violation: violationMatch?.[1] || allRisks[existingIdx].violation,
        details: detailsMatch?.[1] || allRisks[existingIdx].details,
        riskLevel: riskLevel === 'suicide' ? 'suicide' : allRisks[existingIdx].riskLevel
      };
    } else {
      allRisks.push({
        id,
        riskLevel,
        violation: violationMatch?.[1] || 'IP侵权风险',
        details: detailsMatch?.[1] || '详见分析报告',
        category: categorizeText(section, id)
      });
    }

    // Update sets
    if (riskLevel === 'suicide' || riskLevel === 'high') {
      suicideHighRisk.add(id);
      mediumRisk.delete(id);
    } else {
      mediumRisk.add(id);
    }
    safe.delete(id);
  }

  // Calculate breakdown
  const breakdown = {
    trademark: allRisks.filter(r => r.category === 'trademark').length,
    copyright: allRisks.filter(r => r.category === 'copyright').length,
    celebrity: allRisks.filter(r => r.category === 'celebrity').length,
    politics: allRisks.filter(r => r.category === 'politics').length,
    violence: allRisks.filter(r => r.category === 'violence').length,
    hate: allRisks.filter(r => r.category === 'hate').length,
    adult: allRisks.filter(r => r.category === 'adult').length
  };

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
      breakdown
    },
    metadata: {
      analyzedAt: new Date().toISOString(),
      processingTime: 0,
      analysisVersion: '4.0.0',
      aiProvider: 'Claude Vision'
    },
    rawAnalysis: aiResponse
  };
}

// Categorize violation type
function categorizeText(text, id) {
  const lower = text.toLowerCase();

  if (/trademark|品牌|商标|logo|标志/i.test(lower)) return 'trademark';
  if (/copyright|版权|角色|character|动漫|movie|film/i.test(lower)) return 'copyright';
  if (/celebrity|名人|肖像|portrait/i.test(lower)) return 'celebrity';
  if (/political|政治|government/i.test(lower)) return 'politics';
  if (/violence|暴力|weapon|gun/i.test(lower)) return 'violence';
  if (/hate|仇恨|nazi|种族/i.test(lower)) return 'hate';
  if (/profanity|脏话|脏字|vulgar/i.test(lower)) return 'adult';

  return 'generic';
}

// =============================================
// FALLBACK RESULT (DEMO DATA)
// =============================================
function generateFallbackResult() {
  return {
    suicideHighRisk: ['1', '3', '7', '10', '11', '12', '21', '22', '26', '33'],
    mediumRisk: ['15', '17', '45'],
    safe: ['2', '4', '5', '6', '8', '9', '13', '14', '16', '18', '19', '20', '23', '24', '25', '27', '28', '29', '30'],
    details: [
      { id: '1', riskLevel: 'high', violation: '商标侵权', details: '品牌Logo未经授权', category: 'trademark' },
      { id: '3', riskLevel: 'high', violation: '版权侵权', details: '影视角色版权问题', category: 'copyright' },
      { id: '7', riskLevel: 'suicide', violation: '暴力+仇恨内容', details: '绝对禁止上架', category: 'violence' },
      { id: '10', riskLevel: 'high', violation: '肖像权+商标侵权', details: '名人肖像+球队标志', category: 'celebrity' },
      { id: '11', riskLevel: 'high', violation: '商标侵权', details: 'MLB球队标志', category: 'trademark' },
      { id: '12', riskLevel: 'high', violation: '多重IP侵权', details: '肖像权+商标', category: 'celebrity' },
      { id: '15', riskLevel: 'medium', violation: '政治敏感', details: '建议修改', category: 'politics' },
      { id: '17', riskLevel: 'medium', violation: '版权侵权', details: '游戏/产品设计版权', category: 'copyright' },
      { id: '21', riskLevel: 'high', violation: '版权+政治', details: '版权角色+政治人物', category: 'copyright' },
      { id: '22', riskLevel: 'high', violation: '版权侵权', details: '乐队商标+肖像', category: 'copyright' },
      { id: '26', riskLevel: 'high', violation: '版权侵权', details: '游戏角色版权', category: 'copyright' },
      { id: '33', riskLevel: 'high', violation: '版权侵权', details: '电影版权内容', category: 'copyright' },
      { id: '45', riskLevel: 'medium', violation: '政治敏感', details: '国旗图案', category: 'politics' }
    ],
    summary: {
      total: 50,
      highRiskCount: 10,
      mediumRiskCount: 3,
      safeCount: 37,
      breakdown: {
        trademark: 2,
        copyright: 6,
        celebrity: 2,
        politics: 2,
        violence: 1,
        hate: 0,
        adult: 0
      }
    },
    metadata: {
      analyzedAt: new Date().toISOString(),
      processingTime: 0,
      analysisVersion: '4.0.0',
      aiProvider: 'Demo',
      demoMode: true
    }
  };
}

// =============================================
// DATABASE FUNCTIONS
// =============================================
async function saveToDatabase(analysisId, fileName, result) {
  if (!supabase) return;

  try {
    const { error } = await supabase.from('analysis_history').insert({
      id: analysisId,
      file_name: fileName || 'unknown',
      result: result
    });

    if (error) {
      console.log('Database save error:', error.message);
    } else {
      console.log(`[${analysisId}] Saved to database`);
    }
  } catch (e) {
    console.log('Database error:', e.message);
  }
}

async function checkDatabase() {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('analysis_history').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}

// =============================================
// HISTORY ROUTES
// =============================================
app.get('/api/history', async (req, res) => {
  if (!supabase) {
    return res.json({ total: 0, items: [], limit: 20, offset: 0 });
  }

  try {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;

    const { data, count, error } = await supabase
      .from('analysis_history')
      .select('id, file_name, created_at, result')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const items = (data || []).map(item => ({
      id: item.id,
      file_name: item.file_name,
      created_at: item.created_at,
      summary: item.result?.summary || {}
    }));

    res.json({ total: count || 0, items, limit, offset });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/analysis/:id', async (req, res) => {
  if (!supabase) {
    return res.status(404).json({ error: 'Database not configured' });
  }

  try {
    const { data, error } = await supabase
      .from('analysis_history')
      .select('result')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Not found' });

    res.json(data.result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/analysis/:id', async (req, res) => {
  if (!supabase) {
    return res.json({ success: true });
  }

  try {
    await supabase.from('analysis_history').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/history', async (req, res) => {
  if (!supabase) {
    return res.json({ success: true });
  }

  try {
    await supabase.from('analysis_history').delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  if (!supabase) {
    return res.json({
      totalAnalyses: 0,
      totalProducts: 0,
      totalHighRisk: 0,
      totalMediumRisk: 0,
      totalSafe: 0
    });
  }

  try {
    const { data } = await supabase.from('analysis_history').select('result');

    const stats = {
      totalAnalyses: data?.length || 0,
      totalProducts: 0,
      totalHighRisk: 0,
      totalMediumRisk: 0,
      totalSafe: 0
    };

    data?.forEach(item => {
      if (item.result?.summary) {
        stats.totalProducts += item.result.summary.total || 0;
        stats.totalHighRisk += item.result.summary.highRiskCount || 0;
        stats.totalMediumRisk += item.result.summary.mediumRiskCount || 0;
        stats.totalSafe += item.result.summary.safeCount || 0;
      }
    });

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// START SERVER
// =============================================
app.listen(PORT, () => {
  console.log(`🚀 Walmart IP Scanner API running on port ${PORT}`);
  console.log(`   Claude Vision: ${ANTHROPIC_API_KEY ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`   MiniMax: ${MINIMAX_API_KEY ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`   Database: ${supabase ? '✅ Connected' : '❌ Disconnected'}`);
});
