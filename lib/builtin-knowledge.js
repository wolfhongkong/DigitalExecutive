import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError } from './input.js';

export const BUILTIN_DIRECTORY = fileURLToPath(new URL('../knowledge/builtin/', import.meta.url));
export const BUILTIN_PREFIX = 'builtin:';

// Order matters for display. Patterns infer domains from free-text executive roles.
export const KNOWLEDGE_DOMAINS = [
  { id: 'leadership', title: 'Leadership & management', pattern: /\b(ceo|chief executive|president|founder|managing director|general manager|executive director|head of)\b/i },
  { id: 'strategy', title: 'Strategy', pattern: /\b(strateg\w*|cso|ceo|chief executive|business development|corporate development|m&a)\b/i },
  { id: 'finance', title: 'Finance', pattern: /\b(financ\w*|cfo|treasur\w*|controller|accounting|investor relations)\b/i },
  { id: 'people', title: 'People & HR', pattern: /\b(hr|chro|people|human resources|talent|recruit\w*|culture)\b/i },
  { id: 'legal', title: 'Legal & compliance', pattern: /\b(legal|counsel|lawyer|attorney|compliance|gc|clo)\b/i },
  { id: 'operations', title: 'Operations', pattern: /\b(operat\w*|coo|supply chain|logistics|procurement|manufactur\w*)\b/i },
  { id: 'marketing', title: 'Marketing & communications', pattern: /\b(marketing|cmo|brand|communications?|pr|growth)\b/i },
  { id: 'product', title: 'Product', pattern: /\b(product|cpo|cto|technology|engineering|r&d|research)\b/i },
  { id: 'sales', title: 'Sales', pattern: /\b(sales|revenue|cro|commercial|business development|account)\b/i },
  { id: 'board', title: 'Board & investors', pattern: /\b(board|ceo|chief executive|investor|governance|chair\w*|secretary)\b/i },
];
const DOMAIN_IDS = new Set(KNOWLEDGE_DOMAINS.map(domain => domain.id));

// The specialist roles of OpenExecutive's virtual executive team, seeded once as ready-to-chat executives.
export const PREDEFINED_EXECUTIVES = [
  { id: 'chief-strategy-officer', name: 'CSO', role: 'Chief Strategy Officer', domains: ['strategy', 'leadership'],
    bio: 'Built-in specialist for competitive analysis, mergers and acquisitions, market positioning and OKRs.',
    focus: 'Frame answers around where to compete and how to win. Make trade-offs explicit and name what the company should stop doing.' },
  { id: 'chief-financial-officer', name: 'CFO', role: 'Chief Financial Officer', domains: ['finance'],
    bio: 'Built-in specialist for financial modeling, fundraising, unit economics and cash flow.',
    focus: 'Quantify where possible, state assumptions, and always consider cash, runway and downside scenarios.' },
  { id: 'chief-people-officer', name: 'CHRO', role: 'Chief HR and People Officer', domains: ['people'],
    bio: 'Built-in specialist for hiring, compensation, performance management and culture.',
    focus: 'Balance business needs with fairness to employees. Flag where local employment law or HR involvement is required.' },
  { id: 'general-counsel', name: 'General Counsel', role: 'General Counsel', domains: ['legal'],
    bio: 'Built-in specialist for contracts, intellectual property, employment law basics and compliance.',
    focus: 'Give practical business orientation, identify risks and questions for qualified counsel, and state clearly that this is not legal advice.' },
  { id: 'chief-operating-officer', name: 'COO', role: 'Chief Operating Officer', domains: ['operations', 'leadership'],
    bio: 'Built-in specialist for process design, vendor management and operational scaling.',
    focus: 'Turn goals into owners, processes, metrics and timelines. Look for bottlenecks and single points of failure.' },
  { id: 'chief-marketing-officer', name: 'CMO', role: 'Chief Marketing Officer', domains: ['marketing'],
    bio: 'Built-in specialist for go-to-market strategy, brand, communications and PR.',
    focus: 'Start from the target customer and their alternatives. Tie marketing activity to measurable pipeline and brand outcomes.' },
  { id: 'chief-product-officer', name: 'CPO', role: 'Chief Product Officer', domains: ['product'],
    bio: 'Built-in specialist for product strategy, roadmaps and prioritization.',
    focus: 'Anchor recommendations in customer problems and outcomes, not feature lists. Suggest the cheapest way to test risky assumptions.' },
  { id: 'head-of-sales', name: 'Head of Sales', role: 'Head of Sales', domains: ['sales'],
    bio: 'Built-in specialist for pipeline and qualification, founder-led sales, pricing conversations, proposals and forecasting.',
    focus: 'Be concrete about next steps, buyer actions and deal risks. Protect price by trading value rather than discounting.' },
  { id: 'board-communications-director', name: 'Board Communications Director', role: 'Board Communications Director', domains: ['board'],
    bio: 'Built-in specialist for board decks, investor relations and governance.',
    focus: 'Lead with the conclusion and the decision requested. Be candid about bad news and keep metrics consistent over time.' },
];

export function predefinedSoul(baseSoul, executive) {
  return `${baseSoul.trimEnd()}\n\n## Role focus\n${executive.focus}\nUse the built-in ${executive.role} reference knowledge for frameworks and best practices, and say when company-specific facts are missing.\n`;
}

export function inferKnowledgeDomains(role) {
  const domains = KNOWLEDGE_DOMAINS.filter(domain => domain.pattern.test(role || '')).map(domain => domain.id);
  return domains.length ? domains : ['leadership'];
}

export function validateKnowledgeDomains(value) {
  if (!Array.isArray(value) || value.some(domain => !DOMAIN_IDS.has(domain))) {
    throw new InputError(`Knowledge domains must be a list containing only: ${[...DOMAIN_IDS].join(', ')}.`);
  }
  return KNOWLEDGE_DOMAINS.map(domain => domain.id).filter(id => value.includes(id));
}

// Markdown is split at second-level headings so each retrieved excerpt is one coherent section.
function sections(title, content) {
  const parts = content.replace(/^# .*\n+/, '').split(/^(?=## )/m).map(part => part.trim()).filter(Boolean);
  return parts.map(part => `${title}\n${part}`);
}

const cache = new Map();
export function loadBuiltinKnowledge(directory = BUILTIN_DIRECTORY) {
  if (cache.has(directory)) return cache.get(directory);
  const documents = [];
  for (const domain of KNOWLEDGE_DOMAINS) {
    let names;
    try { names = readdirSync(join(directory, domain.id)).filter(name => /^[a-z0-9-]+\.md$/.test(name)).sort(); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const name of names) {
      const content = readFileSync(join(directory, domain.id, name), 'utf8').trim();
      const title = content.match(/^# (.+)$/m)?.[1]?.trim();
      if (!title) throw new Error(`Built-in knowledge file ${domain.id}/${name} must start with a "# Title" heading.`);
      documents.push({ id: `${BUILTIN_PREFIX}${domain.id}/${name.slice(0, -3)}`, domain: domain.id, title, content,
        chunks: sections(title, content) });
    }
  }
  const knowledge = {
    documents,
    document: id => documents.find(document => document.id === id),
    catalog: KNOWLEDGE_DOMAINS.map(domain => ({ id: domain.id, title: domain.title,
      documents: documents.filter(document => document.domain === domain.id).map(({ id, title }) => ({ id, title })) })),
  };
  cache.set(directory, knowledge);
  return knowledge;
}
