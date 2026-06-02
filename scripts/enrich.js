#!/usr/bin/env node
/**
 * AI Design Learning OS — Content Enrichment Pipeline
 *
 * Uses Claude API (claude-haiku-4-5) to:
 *  1. Categorize each article into one of 8 knowledge sections
 *  2. Generate Chinese TLDR (摘要)
 *  3. Generate 设计启发 (design insight)
 *  4. Generate 团队实践建议 (team practice suggestion)
 *
 * Processes articles in batches of 8 to balance speed and token usage.
 * ~$0.001 per 24-article daily run.
 */

const Anthropic = require('@anthropic-ai/sdk');

// ── Section definitions ───────────────────────────────────────────────────────

const CATEGORIES = {
  'ai-cognition': {
    label: 'AI产品认知',
    desc: 'AI产品策略、产品思维底座、AI能力评估、概率性产品设计',
  },
  'ai-ux': {
    label: 'AI用户体验',
    desc: 'AI信任设计、对话界面、错误处理、渐进披露、不确定性表达',
  },
  'ai-agent': {
    label: 'AI Agent',
    desc: '自主AI系统、多步骤自动化、Agent UX、监督机制设计',
  },
  'ai-design-system': {
    label: 'AI设计系统',
    desc: 'AI专属组件库、流式输出、加载态设计Token、无障碍AI',
  },
  'ai-workflow': {
    label: 'AI工作流',
    desc: '设计师AI工具栈、提示词工程、AI辅助原型、AI用研',
  },
  'ai-management': {
    label: 'AI组织管理',
    desc: 'AI时代团队建设、招聘标准、AI素养培育、组织转型',
  },
  'ai-teardown': {
    label: 'AI产品拆解',
    desc: '具体AI产品深度分析、交互决策拆解、UX案例研究',
  },
  'design-director': {
    label: '设计总监专区',
    desc: '设计战略、向高管汇报设计价值、设计组织未来、AI转型领导力',
  },
};

const CATEGORY_IDS = Object.keys(CATEGORIES);

const BATCH_SIZE = 8;

// ── Enrichment ────────────────────────────────────────────────────────────────

async function enrichBatch(articles, client) {
  const articlesText = articles.map((a, i) =>
    `[${i}] 标题: ${a.title}\n来源: ${a.source_name}\n摘要: ${(a.excerpt || '').slice(0, 300)}`
  ).join('\n\n');

  const categoryList = CATEGORY_IDS
    .map(id => `- ${id}: ${CATEGORIES[id].label}（${CATEGORIES[id].desc}）`)
    .join('\n');

  const prompt = `你是 AI Design Learning OS 的内容研究员，服务于中文产品设计师读者。

请分析以下 ${articles.length} 篇英文文章，为每篇生成结构化中文摘要。

【分类选项】只能从以下8个中选一个：
${categoryList}

【文章列表】
${articlesText}

请返回 JSON 数组（严格按原始顺序），每个元素格式：
{
  "index": 0,
  "category": "分类ID（必须是上面8个之一）",
  "tldr": "2-3句中文摘要，聚焦核心洞察，面向产品设计师，不超过80字",
  "insight": "一句话设计启发（具体可操作，以「→」开头，不超过40字）",
  "suggestion": "一句话团队实践建议（以「建议」或「试试」或「下次」开头，不超过40字）"
}

规则：
- tldr/insight/suggestion 全部用中文
- 仅输出 JSON 数组，不要代码块标记，不要任何其他文字`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();

  let results;
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    results = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (e) {
    console.error('  ✗ Enrichment JSON parse error:', e.message);
    console.error('  Raw response:', text.slice(0, 400));
    return articles.map(a => fallback(a));
  }

  return articles.map((article, i) => {
    const r = Array.isArray(results)
      ? (results.find(x => x.index === i) || results[i] || {})
      : {};
    return {
      ...article,
      category: CATEGORY_IDS.includes(r.category) ? r.category : guessCategory(article),
      tldr: r.tldr || article.excerpt || '',
      insight: r.insight || '',
      suggestion: r.suggestion || '',
      enriched: true,
    };
  });
}

function fallback(article) {
  return {
    ...article,
    category: guessCategory(article),
    tldr: article.excerpt || '',
    insight: '',
    suggestion: '',
    enriched: false,
  };
}

// Heuristic fallback categorization by source + keywords
function guessCategory(article) {
  const text = (article.title + ' ' + (article.excerpt || '')).toLowerCase();
  const src = article.source_id || '';

  if (['nngroup', 'figma'].includes(src)) {
    if (text.includes('agent') || text.includes('automat')) return 'ai-agent';
    if (text.includes('design system') || text.includes('component')) return 'ai-design-system';
    return 'ai-ux';
  }
  if (['hbr', 'mit-sloan', 'mckinsey', 'bcg'].includes(src)) {
    if (text.includes('ceo') || text.includes('board') || text.includes('execut')) return 'design-director';
    return 'ai-management';
  }
  if (['linear', 'notion'].includes(src)) return 'ai-workflow';
  if (text.includes('agent') || text.includes('autonom')) return 'ai-agent';
  if (text.includes('ux') || text.includes('user experience') || text.includes('trust')) return 'ai-ux';
  if (text.includes('design system') || text.includes('component')) return 'ai-design-system';
  if (text.includes('team') || text.includes('organi') || text.includes('manag')) return 'ai-management';
  if (text.includes('workflow') || text.includes('tool') || text.includes('prototype')) return 'ai-workflow';
  return 'ai-cognition';
}

// ── Public API ────────────────────────────────────────────────────────────────

async function enrichArticles(articles) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('  ⚠ ANTHROPIC_API_KEY not set — skipping AI enrichment, using heuristics');
    return articles.map(fallback);
  }

  const client = new Anthropic({ apiKey });
  const enriched = [];

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    console.log(`  ✦ Enriching articles ${i + 1}–${i + batch.length} of ${articles.length}…`);
    try {
      const results = await enrichBatch(batch, client);
      enriched.push(...results);
    } catch (e) {
      console.error(`  ✗ Batch enrichment failed: ${e.message}`);
      enriched.push(...batch.map(fallback));
    }
    // Small delay between batches to avoid rate limits
    if (i + BATCH_SIZE < articles.length) await new Promise(r => setTimeout(r, 500));
  }

  return enriched;
}

module.exports = { enrichArticles, CATEGORIES, CATEGORY_IDS, guessCategory };
